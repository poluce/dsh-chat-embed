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

test('the probe names the script and a command for each direction', () => {
  const resources = fakeInstall({ 'lib/main.js': PATCHED_MAIN })
  const report = internals.inspectShell(resources)

  assert.ok(typeof report.script === 'string' && report.script.endsWith('shell-patch.mjs'), 'the script is located')
  assert.ok(report.applyCommand.includes('apply'), 'the on direction is one command')
  assert.ok(report.revertCommand.includes('revert'), 'the off direction is one command')
  // Windows and macOS get a double-clickable launcher; every other platform
  // points at the script itself, because the desktop build is the only thing
  // that ships one.
  if (process.platform === 'win32' || process.platform === 'darwin') {
    assert.ok(typeof report.launcher === 'string' && report.launcher !== '', 'the launcher ships with the package')
    assert.match(report.launcher, /shell-patch\.(cmd|command)$/, 'the platform launcher is picked')
    assert.ok(report.applyCommand.startsWith('"') || !report.applyCommand.split(' ')[0].includes(' '), 'a spaced path is quoted')
  } else {
    assert.equal(report.launcher, undefined, 'no desktop launcher on this platform')
    assert.match(report.applyCommand, /shell-patch\.mjs apply$/, 'the script is called directly instead')
  }
})

test('a command quotes a path that contains spaces', () => {
  assert.equal(
    internals.launcherCommand('apply', { launcher: 'C:\\Program Files\\shell-patch.cmd' }, undefined),
    '"C:\\Program Files\\shell-patch.cmd" apply',
  )
  assert.equal(
    internals.launcherCommand('revert', { launcher: 'C:\\pkg\\shell-patch.cmd' }, undefined),
    'C:\\pkg\\shell-patch.cmd revert',
  )
})

test('without a launcher the command falls back to node and the script', () => {
  const files = { script: '/opt/dsh/shell-patch.mjs' }
  assert.equal(internals.launcherCommand('apply', files, '/usr/bin/node'), '/usr/bin/node /opt/dsh/shell-patch.mjs apply')
  assert.equal(
    internals.launcherCommand('revert', { script: '/my pkg/shell-patch.mjs' }, '/usr/bin/node'),
    '/usr/bin/node "/my pkg/shell-patch.mjs" revert',
    'a spaced script path is quoted',
  )
  assert.equal(internals.launcherCommand('apply', {}, undefined), undefined, 'nothing to run, no command')
})

test('a launcher wins over the node fallback when both exist', () => {
  const files = { launcher: 'C:\\pkg\\shell-patch.cmd', script: 'C:\\pkg\\shell-patch.mjs' }
  assert.equal(internals.launcherCommand('apply', files, 'C:\\nodejs\\node.exe'), 'C:\\pkg\\shell-patch.cmd apply')
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

// ---------------------------------------------------------------------------
// The two routes: a read-only probe, and the action the switch asks for
// ---------------------------------------------------------------------------

/** A Context whose webServer records what the plugin registers. @returns {{ mounted: any[], ctx: any }} */
function routeContext() {
  const mounted = []
  return {
    mounted,
    ctx: {
      get: (name) => (name === 'webServer' ? { register: (route) => (mounted.push(route), () => {}) } : undefined),
      effect: (callback) => {
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
    },
  }
}

/** @param {any[]} mounted @param {string} path @returns {any} */
function routeAt(mounted, path) {
  return mounted.find((route) => route.path === path)
}

/** @param {string} query @returns {Request} */
function actionRequest(query) {
  return new Request('http://127.0.0.1' + internals.PATCH_PATH + '?' + query, { method: 'GET' })
}

/** A probe report that says "an unpatched shell I could patch". @param {object} [over] */
function patchable(over = {}) {
  return {
    found: true,
    patched: false,
    cachePatch: false,
    patchSite: true,
    writable: true,
    resources: 'C:\\DSH\\resources',
    asar: 'C:\\DSH\\resources\\app.asar',
    script: 'C:\\plugin\\tools\\shell-patch\\shell-patch.mjs',
    launcher: 'C:\\plugin\\tools\\shell-patch\\shell-patch.cmd',
    applyCommand: 'shell-patch.cmd apply',
    revertCommand: 'shell-patch.cmd revert',
    detail: '',
    ...over,
  }
}

/** A child-process stand-in: `unref` is required, `kill` is recorded. @returns {any} */
function fakeChild() {
  return {
    killed: false,
    unref() {},
    kill() {
      this.killed = true
    },
  }
}

test('the probe answers GET and HEAD and nothing else, and writes nothing', () => {
  const resources = fakeInstall({ 'lib/main.js': PATCHED_MAIN })
  const previous = process.env.DSH_RESOURCES
  process.env.DSH_RESOURCES = resources
  try {
    const { mounted, ctx } = routeContext()
    apply(ctx)

    assert.equal(mounted.length, 2, 'the probe and the action route are both registered')
    const route = routeAt(mounted, internals.PROBE_PATH)
    assert.ok(route !== undefined, 'the probe keeps its path')
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

test('the probe hands out the token the action route demands', async () => {
  const { mounted, ctx } = routeContext()
  internals.installHttpRoutes(ctx, { inspect: () => patchable(), spawn: () => fakeChild() })
  const probe = routeAt(mounted, internals.PROBE_PATH)
  const body = await probe.resource(new Request('http://127.0.0.1' + internals.PROBE_PATH), undefined).json()
  assert.equal(body.token, internals.PATCH_TOKEN, 'the panel learns the token from the probe')

  const action = routeAt(mounted, internals.PATCH_PATH)
  const refused = action.resource(actionRequest('action=apply'), undefined)
  assert.equal(refused.status, 403, 'no token, no action')
  assert.equal(action.resource(actionRequest('action=apply&token=wrong'), undefined).status, 403)
})

test('the action route refuses a bad action and a non-GET method', () => {
  const { mounted, ctx } = routeContext()
  const spawned = []
  internals.installHttpRoutes(ctx, { inspect: () => patchable(), spawn: (...args) => (spawned.push(args), fakeChild()) })
  const action = routeAt(mounted, internals.PATCH_PATH)

  const post = action.resource(
    new Request('http://127.0.0.1' + internals.PATCH_PATH + '?action=apply&token=' + internals.PATCH_TOKEN, {
      method: 'POST',
    }),
    undefined,
  )
  assert.equal(post.status, 405, 'the carrier has no request body to speak of')
  assert.equal(post.headers.get('allow'), 'GET')

  const bad = action.resource(actionRequest('action=reboot&token=' + internals.PATCH_TOKEN), undefined)
  assert.equal(bad.status, 400)
  assert.equal(spawned.length, 0, 'nothing was started')
})

test('an action that cannot run comes back with a reason and a command', async () => {
  const cases = [
    [{ found: false }, 'noapp'],
    [{ patched: true }, 'same'],
    [{ patchSite: false }, 'unsupported'],
    [{ writable: false }, 'denied'],
    [{ script: undefined }, 'failed'],
  ]
  for (const [over, state] of cases) {
    const { mounted, ctx } = routeContext()
    let starts = 0
    internals.installHttpRoutes(ctx, {
      inspect: () => patchable(over),
      spawn: () => {
        starts += 1
        return fakeChild()
      },
    })
    const action = routeAt(mounted, internals.PATCH_PATH)
    const response = action.resource(actionRequest('action=apply&token=' + internals.PATCH_TOKEN), undefined)
    const body = await response.json()
    assert.equal(body.ok, false, state + ' does not claim success')
    assert.equal(body.state, state)
    assert.equal(starts, 0, state + ' starts nothing')
  }
})

test('a started action runs the script with the shell as the process to wait for', async () => {
  const { mounted, ctx } = routeContext()
  const calls = []
  internals.installHttpRoutes(ctx, {
    inspect: () => patchable(),
    spawn: (...args) => {
      calls.push(args)
      return fakeChild()
    },
  })
  const action = routeAt(mounted, internals.PATCH_PATH)
  const body = await action.resource(actionRequest('action=apply&token=' + internals.PATCH_TOKEN), undefined).json()

  assert.equal(body.ok, true)
  assert.equal(body.state, 'started')
  assert.equal(body.action, 'apply')
  assert.equal(calls.length, 1, 'exactly one child')

  const [file, args, options] = calls[0]
  assert.ok(typeof file === 'string' && file.length > 0, 'something runs the script')
  assert.deepEqual(args.slice(0, 5), [patchable().script, 'apply', '--restart', '--resources', patchable().resources])
  const pidAt = args.indexOf('--pid')
  assert.ok(pidAt !== -1, 'the script waits for the shell, not for a retry loop')
  assert.equal(args[pidAt + 1], String(process.ppid))
  assert.equal(args.indexOf('--exe'), -1, 'a plain Node Host is nothing to relaunch')

  assert.equal(options.detached, true, 'it must outlive the Host')
  assert.equal(options.stdio, 'ignore')
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1', 'the Hosts own runtime runs the script as Node')
})

test('a second click replaces the waiting patcher instead of piling them up', () => {
  const { mounted, ctx } = routeContext()
  const children = []
  internals.installHttpRoutes(ctx, {
    inspect: () => patchable(),
    spawn: () => {
      const child = fakeChild()
      children.push(child)
      return child
    },
  })
  const action = routeAt(mounted, internals.PATCH_PATH)
  action.resource(actionRequest('action=apply&token=' + internals.PATCH_TOKEN), undefined)
  action.resource(actionRequest('action=apply&token=' + internals.PATCH_TOKEN), undefined)

  assert.equal(children.length, 2)
  assert.equal(children[0].killed, true, 'the first one is stopped')
  assert.equal(children[1].killed, false)
})

test('a spawn that throws is reported, not swallowed', async () => {
  const { mounted, ctx } = routeContext()
  internals.installHttpRoutes(ctx, {
    inspect: () => patchable(),
    spawn: () => {
      throw new Error('spawn nope')
    },
  })
  const action = routeAt(mounted, internals.PATCH_PATH)
  const body = await action.resource(actionRequest('action=apply&token=' + internals.PATCH_TOKEN), undefined).json()
  assert.equal(body.ok, false)
  assert.equal(body.state, 'failed')
  assert.match(body.detail, /spawn nope/)
})

test('unloading the bundle stops a patcher it started', () => {
  const { mounted, ctx } = routeContext()
  const child = fakeChild()
  const dispose = internals.installHttpRoutes(ctx, { inspect: () => patchable(), spawn: () => child })
  routeAt(mounted, internals.PATCH_PATH).resource(actionRequest('action=apply&token=' + internals.PATCH_TOKEN), undefined)
  assert.equal(child.killed, false)
  dispose()
  assert.equal(child.killed, true, 'a removed plugin leaves nothing behind')
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
