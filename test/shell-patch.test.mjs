/**
 * Contract tests for `tools/shell-patch/shell-patch.mjs`.
 *
 * The script is the whole "logins survive a restart" feature now: it builds the
 * patched archive, proves it, swaps it in, and undoes it. Every one of those
 * steps is exercised here against synthetic asar archives, so a regression
 * fails a test instead of corrupting somebody's install.
 *
 * What the script talks to on a real machine — the app.asar of a running
 * desktop app — is only ever touched through its own CLI, and those files are
 * produced by the test, never read from disk.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { afterEach } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(here, '..', 'tools', 'shell-patch', 'shell-patch.mjs')

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
 * Build a minimal asar that holds the entries given.
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

const UNPATCHED_MAIN = [
  'let partition = this.partitions.get(workspace);',
  'if (partition === void 0) {',
  '  partition = `dsh-sidebar-browser-${randomUUID()}`;',
  '  this.configureSession(session.fromPartition(partition));',
  '  this.partitions.set(workspace, partition);',
  '}',
].join('\n')

/** Two entries, so "every other file is byte-identical" is a real assertion. */
const ENTRIES = {
  'lib/main.js': UNPATCHED_MAIN,
  'package.json': '{"name":"deepseek-harness","version":"0.2.2"}',
}

/** @param {Buffer} buffer @returns {string} */
function hashOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** @param {Buffer} buffer @returns {string} the resources directory */
function install(buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'dshce-shell-'))
  scratch.push(dir)
  writeFileSync(join(dir, 'app.asar'), buffer)
  return dir
}

/**
 * @param {string[]} args
 * @returns {{ code: number, out: string }}
 */
function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  })
  return { code: result.status === null ? -1 : result.status, out: (result.stdout || '') + (result.stderr || '') }
}

/** @param {string} dir @returns {string} the archive's sha256 */
function archiveHash(dir) {
  return hashOf(readFileSync(join(dir, 'app.asar')))
}

// ---------------------------------------------------------------------------

test('status reports a pristine archive and writes nothing', () => {
  const dir = install(buildAsar(ENTRIES))
  const before = archiveHash(dir)

  const { code, out } = run(['status', '--resources', dir])
  assert.equal(code, 0)
  assert.match(out, /未开启/)
  assert.match(out, /原版备份\s+无/)
  assert.equal(archiveHash(dir), before, 'status must not touch the archive')
  assert.equal(existsSync(join(dir, 'app.asar.orig')), false, 'status invents no backup')
})

test('apply patches the archive and keeps a pristine backup', () => {
  const dir = install(buildAsar(ENTRIES))
  const original = readFileSync(join(dir, 'app.asar'))

  const { code, out } = run(['apply', '--resources', dir, '--yes'])
  assert.equal(code, 0)
  assert.match(out, /逐字节一致/, 'the rebuild is proven before the swap')
  assert.match(out, /重新打开 DSH/, 'the restart is the only follow-up')

  const patched = readFileSync(join(dir, 'app.asar'))
  assert.notEqual(hashOf(patched), hashOf(original), 'the archive changed')
  assert.ok(readFileSync(join(dir, 'app.asar.orig')).equals(original), 'the backup is the exact original')
})

test('apply is idempotent and leaves the archive alone the second time', () => {
  const dir = install(buildAsar(ENTRIES))
  assert.equal(run(['apply', '--resources', dir, '--yes']).code, 0)
  const once = archiveHash(dir)

  const { code, out } = run(['apply', '--resources', dir, '--yes'])
  assert.equal(code, 0)
  assert.match(out, /已经开启/, 'it says so instead of rebuilding')
  assert.equal(archiveHash(dir), once, 'the archive is untouched')
})

test('revert restores the exact original bytes', () => {
  const dir = install(buildAsar(ENTRIES))
  const original = readFileSync(join(dir, 'app.asar'))

  assert.equal(run(['apply', '--resources', dir, '--yes']).code, 0)
  const { code, out } = run(['revert', '--resources', dir, '--yes'])
  assert.equal(code, 0)
  assert.match(out, /逐字节一致/)

  assert.equal(hashOf(readFileSync(join(dir, 'app.asar'))), hashOf(original), 'a full round-trip is lossless')
  assert.ok(existsSync(join(dir, 'app.asar.patched.bak')), 'the patched copy is kept, not deleted')
})

test('revert does not depend on the backup being pristine', () => {
  const dir = install(buildAsar(ENTRIES))
  const original = readFileSync(join(dir, 'app.asar'))
  assert.equal(run(['apply', '--resources', dir, '--yes']).code, 0)
  // The failure this guards against: an older build left a *patched* archive at
  // app.asar.orig, so restoring from it looked like it worked and did nothing.
  writeFileSync(join(dir, 'app.asar.orig'), readFileSync(join(dir, 'app.asar')))

  const { code } = run(['revert', '--resources', dir, '--yes'])
  assert.equal(code, 0)
  assert.equal(hashOf(readFileSync(join(dir, 'app.asar'))), hashOf(original), 'still the real original')
})

test('apply never overwrites a pristine backup', () => {
  const dir = install(buildAsar(ENTRIES))
  const original = readFileSync(join(dir, 'app.asar'))
  assert.equal(run(['apply', '--resources', dir, '--yes']).code, 0)
  assert.equal(run(['revert', '--resources', dir, '--yes']).code, 0)
  // Now app.asar.orig is clean and app.asar is pristine again; patching a
  // second time must keep the good backup rather than replace it with a copy of
  // whatever is in front of it.
  writeFileSync(join(dir, 'app.asar.orig'), original)
  assert.equal(run(['apply', '--resources', dir, '--yes']).code, 0)
  assert.equal(hashOf(readFileSync(join(dir, 'app.asar.orig'))), hashOf(original), 'the backup survived')
})

test('apply refuses a shell whose patch site is gone, and changes nothing', () => {
  const dir = install(buildAsar({ 'lib/main.js': 'let partition = makeSomethingElse(workspace);' }))
  const before = archiveHash(dir)

  const { code, out } = run(['apply', '--resources', dir, '--yes'])
  assert.notEqual(code, 0, 'it fails instead of guessing')
  assert.match(out, /补丁点/)
  assert.equal(archiveHash(dir), before, 'nothing was written')
  assert.equal(existsSync(join(dir, 'app.asar.new')), false, 'no staged file is left behind')
})

test('revert on an unpatched archive is a no-op', () => {
  const dir = install(buildAsar(ENTRIES))
  const before = archiveHash(dir)

  const { code, out } = run(['revert', '--resources', dir, '--yes'])
  assert.equal(code, 0)
  assert.match(out, /无需还原/)
  assert.doesNotMatch(out, /重新打开 DSH/, 'a no-op does not ask for a restart')
  assert.equal(archiveHash(dir), before)
})

test('a missing install is reported, not thrown', () => {
  const { code, out } = run(['status', '--resources', join(tmpdir(), 'dshce-nowhere-at-all')])
  assert.notEqual(code, 0)
  assert.match(out, /没有找到|不像是|no app\.asar/)
})

test('a malformed archive is reported, not thrown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshce-shell-'))
  scratch.push(dir)
  writeFileSync(join(dir, 'app.asar'), 'this is not an asar archive')

  const { code, out } = run(['status', '--resources', dir])
  assert.notEqual(code, 0)
  assert.doesNotMatch(out, /at .*\\n\s+at /, 'no stack trace is dumped at the user')
})

test('the launchers exist and are the ones the Host reports', () => {
  // The Host half points the user at these two paths; a rename here without a
  // matching change there is a dead link in the dialog.
  assert.ok(existsSync(join(here, '..', 'tools', 'shell-patch', 'shell-patch.cmd')), 'the Windows launcher ships')
  assert.ok(existsSync(join(here, '..', 'tools', 'shell-patch', 'shell-patch.command')), 'the macOS launcher ships')
})

test('the Windows launcher stays inside the console codepage', () => {
  // A batch file is read through the OEM codepage. A multi-byte character in a
  // `rem` line was enough to break the parser; the launcher therefore holds
  // ASCII only, and the Chinese lives in the .mjs it calls.
  const launcher = readFileSync(join(here, '..', 'tools', 'shell-patch', 'shell-patch.cmd'))
  const high = [...launcher].filter((byte) => byte > 127)
  assert.deepEqual(high, [], 'the batch file is pure ASCII')
})
