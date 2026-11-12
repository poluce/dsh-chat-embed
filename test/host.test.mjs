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

test('the probe resolves a Node binary and a runnable command', () => {
  const resources = fakeInstall({ 'lib/main.js': PATCHED_MAIN })
  const report = internals.inspectShell(resources)

  assert.ok(typeof report.nodeBinary === 'string' && report.nodeBinary !== '', 'a Node binary is found')
  assert.match(report.nodeBinary, /node(\.exe)?$/i)
  assert.ok(typeof report.patchScript === 'string', 'the patch tool is located inside this package')
  assert.ok(typeof report.patchCommand === 'string' && report.patchCommand.includes('build'))
  assert.ok(report.patchCommand.includes('--resources'), 'a detected install is passed explicitly')
  assert.ok(report.patchCommand.split(' ')[0].startsWith('"') || !report.patchCommand.split(' ')[0].includes(' '), 'a spaced path is quoted')
})

test('the command quotes paths that contain spaces', () => {
  assert.equal(
    internals.patchCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\pkg\\tools\\patch.cjs'),
    '"C:\\Program Files\\nodejs\\node.exe" C:\\pkg\\tools\\patch.cjs build',
  )
  assert.equal(
    internals.patchCommand('C:\\nodejs\\node.exe', 'C:\\pkg\\tools\\patch.cjs'),
    'C:\\nodejs\\node.exe C:\\pkg\\tools\\patch.cjs build',
  )
})

test('the command points the tool at a non-standard install', () => {
  const command = internals.patchCommand(
    'C:\\nodejs\\node.exe',
    'C:\\pkg\\patch-asar.cjs',
    'E:\\Custom Install\\resources',
  )
  assert.match(command, /--resources/, 'the tool only searches the usual locations')
  assert.match(command, /"E:\\Custom Install\\resources"/, 'a spaced install path is quoted')
  assert.ok(command.endsWith('"'), 'the path is the last argument')
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

test('the patch checker registers one read-only agent tool', async () => {
  const resources = fakeInstall({ 'lib/main.js': PATCHED_MAIN })
  const registered = []
  const ctx = {
    get: (name) =>
      name === 'tools'
        ? { register: (definition) => (registered.push(definition), () => {}) }
        : undefined,
    effect: (callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  apply(ctx)

  assert.equal(registered.length, 1, 'one tool is registered')
  const tool = registered[0]
  assert.equal(tool.name, 'dsh_chat_embed_patch_check')
  assert.match(tool.description, /read-only/i, 'the description states that nothing is written')

  const report = await tool.execute({ resources })
  assert.equal(report.patched, true, 'the tool answers with the same probe')
  const rendered = tool.output.render({ resources }, report)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /"patched": true/)
})

test('the tool is optional when the composition has no tool registry', () => {
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
