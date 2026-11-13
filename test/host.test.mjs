/**
 * Contract tests for the Host half: the shell probe behind "check the patch
 * setup" and the optional HTTP route the panel reads.
 *
 * The probe is the only place the plugin looks at the desktop shell's disk, so
 * every branch that decides "patched / not patched / unknown" is pinned here.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach } from 'node:test'

import { apply, internals } from '../index.js'

/** Scratch directories created by a test, removed afterwards. */
const scratch = []

afterEach(() => {
  while (scratch.length > 0) {
    const dir = scratch.pop()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      void error
    }
  }
})

/**
 * Build a minimal asar archive that holds exactly the entries given.
 *
 * The container format is the one the probe reads: `u32 @0 = 4`,
 * `u32 @4 = headerLen + 8`, `u32 @8 = headerLen + 4`, `u32 @12 = headerLen`,
 * the JSON header, padding to a 4-byte boundary, then the concatenated data.
 *
 * @param {Record<string, string>} entries path → UTF-8 content
 * @returns {Buffer}
 */
function buildAsar(entries) {
  const header = { files: {} }
  const chunks = []
  let cursor = 0
  for (const [path, content] of Object.entries(entries)) {
    const buffer = Buffer.from(content, 'utf8')
    const segments = path.split('/')
    let node = header
    for (const segment of segments.slice(0, -1)) {
      node.files[segment] ??= { files: {} }
      node = node.files[segment]
    }
    node.files[segments.at(-1)] = {
      size: buffer.length,
      offset: String(cursor),
      integrity: {
        algorithm: 'SHA256',
        hash: createHash('sha256').update(buffer).digest('hex'),
        blockSize: 4194304,
        blocks: [createHash('sha256').update(buffer).digest('hex')],
      },
    }
    chunks.push(buffer)
    cursor += buffer.length
  }
  const headerBuffer = Buffer.from(JSON.stringify(header), 'utf8')
  const padding = (4 - (headerBuffer.length % 4)) % 4
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(headerBuffer.length + 8, 4)
  prefix.writeUInt32LE(headerBuffer.length + 4, 8)
  prefix.writeUInt32LE(headerBuffer.length, 12)
  return Buffer.concat([prefix, headerBuffer, Buffer.alloc(padding), ...chunks])
}

/** @param {Record<string, string>} entries @returns {string} the resources directory */
function fakeInstall(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'dshce-probe-'))
  scratch.push(dir)
  writeFileSync(join(dir, 'app.asar'), buildAsar(entries))
  return dir
}

const PATCHED_MAIN = [
  'let partition = this.partitions.get(workspace);',
  'if (partition === void 0) {',
  '  partition = `persist:dsh-sidebar-${createHash("sha256").update(workspace).digest("hex").slice(0, 24)}`;',
  '  this.configureSession(session.fromPartition(partition, { cache: false }));',
  '}',
].join('\n')

const UNPATCHED_MAIN = [
  'let partition = this.partitions.get(workspace);',
  'if (partition === void 0) {',
  '  partition = `dsh-sidebar-browser-${randomUUID()}`;',
  '  this.configureSession(session.fromPartition(partition));',
  '}',
].join('\n')

test('the probe reports a patched archive and its install location', () => {
  const resources = fakeInstall({ 'lib/main.js': PATCHED_MAIN })
  const report = internals.inspectShell(resources)

  assert.equal(report.found, true)
  assert.equal(report.resources, resources)
  assert.equal(report.exists, true)
  assert.equal(report.patched, true, 'the persist: mark is found')
  assert.equal(report.cachePatch, true, 'the cache: false mark is found')
  assert.equal(report.patchSite, true)
  assert.equal(report.backup, false, 'no backup was written')
  assert.equal(report.staged, false, 'no staged archive'
  )
  assert.ok(typeof report.asarHash === 'string' && report.asarHash.length === 16, 'a short content hash is reported')
})

test('the probe reports an unpatched archive as a patch site it can still edit', () => {
  const resources = fakeInstall({ 'lib/main.js': UNPATCHED_MAIN })
  const report = internals.inspectShell(resources)

  assert.equal(report.patched, false)
  assert.equal(report.patchSite, true, 'the original partition line is present')
  assert.match(report.detail, /尚未打补丁/)
})

test('the probe calls out a shell whose patch site is gone', () => {
  const resources = fakeInstall({
    'lib/main.js': 'let partition = makeSomethingElse(workspace);',
  })
  const report = internals.inspectShell(resources)

  assert.equal(report.patched, false)
  assert.equal(report.patchSite, false, 'the shape the patch needs is missing')
  assert.match(report.detail, /补丁点不存在/)
})

test('the probe names the script and both directions', () => {
  const resources = fakeInstall({ 'lib/main.js': PATCHED_MAIN })
  const report = internals.inspectShell(resources)

  assert.ok(typeof report.launcher === 'string' && report.launcher !== '', 'the launcher ships with the package')
  assert.match(report.launcher, /shell-patch\.(cmd|command)$/, 'the platform launcher is picked')
  assert.ok(typeof report.script === 'string' && report.script.endsWith('shell-patch.mjs'), 'the script is located')
  assert.ok(report.applyCommand.includes('apply'), 'the on direction is one command')
  assert.ok(report.revertCommand.includes('revert'), 'the off direction is one command')
  assert.equal(report.nodeBinary, undefined, 'no Node binary to worry about: the launcher finds its own')
})

test('the launcher command quotes a path that contains spaces', () => {
  assert.equal(internals.launcherCommand('apply', 'C:\\Program Files\\shell-patch.cmd'), '"C:\\Program Files\\shell-patch.cmd" apply')
  assert.equal(internals.launcherCommand('revert', 'C:\\pkg\\shell-patch.cmd'), 'C:\\pkg\\shell-patch.cmd revert')
  assert.equal(internals.launcherCommand('apply', undefined), undefined, 'no launcher, no command')
})

test('a backup that is itself patched is reported as such', () => {
  const resources = fakeInstall({ 'lib/main.js': UNPATCHED_MAIN })
  // A patched copy sitting at app.asar.orig is what a careless re-patch leaves
  // behind, and restoring from it silently does nothing.
  writeFileSync(join(resources, 'app.asar.orig'), buildAsar({ 'lib/main.js': PATCHED_MAIN }))

  const report = internals.inspectShell(resources)
  assert.equal(report.backup, true, 'the file exists')
  assert.equal(report.backupClean, false, 'but it is not a restore point')
})

test('a pristine backup is reported as clean', () => {
  const resources = fakeInstall({ 'lib/main.js': PATCHED_MAIN })
  writeFileSync(join(resources, 'app.asar.orig'), buildAsar({ 'lib/main.js': UNPATCHED_MAIN }))

  const report = internals.inspectShell(resources)
  assert.equal(report.backupClean, true)
})

test('the probe names a missing install instead of failing', () => {
  const report = internals.inspectShell(join(tmpdir(), 'dshce-does-not-exist'))
  assert.equal(report.found, false)
  assert.ok(typeof report.detail === 'string' && report.detail.length > 0)
})

test('the probe fetches only GET and HEAD, and never writes', () => {
  const resources = fakeInstall({ 'lib/main.js': PATCHED_MAIN })
  const previous = process.env.DSH_RESOURCES
  process.env.DSH_RESOURCES = resources
  try {
    const mounted = []
    const ctx = {
      get: (name) => (name === 'webServer' ? { register: (route) => (mounted.push(route), () => {}) } : undefined),
      effect: (callback) => {
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
    }
    apply(ctx)

    assert.equal(mounted.length, 1, 'one route is registered')
    const route = mounted[0]
    assert.equal(route.path, internals.PROBE_PATH)
    assert.equal(route.kind, 'exact')

    const body = route.resource(new Request('http://127.0.0.1' + route.path, { method: 'GET' }), undefined)
    assert.equal(body.status, 200)
    assert.match(body.headers.get('content-type'), /application\/json/)
    assert.equal(body.headers.get('cache-control'), 'no-store')

    const rejected = route.resource(new Request('http://127.0.0.1' + route.path, { method: 'POST' }), undefined)
    assert.equal(rejected.status, 405, 'the probe is read-only')
  } finally {
    if (previous === undefined) delete process.env.DSH_RESOURCES
    else process.env.DSH_RESOURCES = previous
  }
})

test('the Host half waits for the service it needs', async () => {
  // The loader calls apply while the tree is still assembling. Without a
  // declared inject the lookup reads undefined and the route is skipped without
  // a word — which is how 0.6.9 shipped.
  const module = await import('../index.js')
  assert.deepEqual(module.inject, ['webServer'], 'the one service it needs is declared')
  assert.equal(typeof module.apply, 'function', 'the plugin still exports apply')
})

test('a Host without a tool registry still loads', () => {
  const ctx = {
    get: () => undefined,
    effect: (callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  assert.doesNotThrow(() => apply(ctx))
})

test('the probe stays optional when the composition has no webserver', () => {
  const ctx = {
    get: () => undefined,
    effect: (callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  assert.doesNotThrow(() => apply(ctx), 'a Host without a webserver still loads')
})

test('the probe survives a malformed host context', () => {
  assert.doesNotThrow(() => apply(undefined))
  assert.doesNotThrow(() => apply({}))
})
