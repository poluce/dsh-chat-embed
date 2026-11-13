#!/usr/bin/env node
/**
 * shell-patch.mjs — turn "logins survive a restart" on or off for the DSH
 * desktop shell, on Windows and macOS, without an agent and without editing
 * anything by hand.
 *
 * Why a patch is needed at all: the desktop shell names every embedded browser
 * partition `dsh-sidebar-browser-<random uuid>` — no `persist:` prefix, so
 * Chromium keeps it in memory, and a fresh uuid on every launch, so every
 * embedded page is signed out by a restart. Hashing the workspace identity
 * instead makes the partition stable on disk; the login itself already lives
 * there, so nothing else has to change.
 *
 * Usage:
 *
 *   node shell-patch.mjs                 interactive menu
 *   node shell-patch.mjs status          report only, writes nothing
 *   node shell-patch.mjs apply           turn the feature on
 *   node shell-patch.mjs revert          turn it off again
 *
 * Options:
 *   --resources <dir>   the install directory that holds app.asar
 *                       (default: $DSH_RESOURCES, then the usual locations)
 *   --yes               answer every question with yes
 *   --no-cache-patch    keep the disk cache; only the partition goes persistent
 *
 * Safety: the new archive is rebuilt from the old one's own bytes, every
 * untouched entry must come out byte-identical, and only then is it swapped in.
 * The previous archive is kept. Running the same command twice is harmless.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// The patch: two literal rewrites, each inverted by `revert`
// ---------------------------------------------------------------------------

const PERSIST_FROM = 'partition = `dsh-sidebar-browser-${randomUUID()}`;'
const PERSIST_TO =
  'partition = `persist:dsh-sidebar-${createHash("sha256").update(workspace).digest("hex").slice(0, 24)}`;'
const CACHE_FROM = 'this.configureSession(session.fromPartition(partition));'
const CACHE_TO = 'this.configureSession(session.fromPartition(partition, { cache: false }));'

/** Marks that tell a patched archive from a pristine one. */
const PATCH_MARK = 'persist:dsh-sidebar-'
const CACHE_MARK = 'fromPartition(partition, { cache: false })'

const MAIN_ENTRY = 'lib/main.js'
const BACKUP = 'app.asar.orig'
const PATCHED_COPY = 'app.asar.patched.bak'
const STAGED = 'app.asar.new'
const BLOCK_SIZE = 4194304

const SELF = fileURLToPath(import.meta.url)
const isTty = process.stdout.isTTY === true

/** Set when a command actually replaced app.asar, so a no-op never says "restart". */
let changed = false

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** @param {string} [line] */
function say(line) {
  console.log(line === undefined ? '' : line)
}

/** @param {number} bytes */
function plural(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/** @param {unknown} error @returns {string} */
function reasonOf(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.split('\n')[0].slice(0, 300)
}

/** @param {string} question @returns {Promise<string>} '' when nobody can answer */
async function ask(question) {
  if (!isTty) return ''
  process.stdout.write('  ' + question + ' ')
  return new Promise((done) => {
    const onData = (chunk) => {
      process.stdin.pause()
      process.stdin.removeListener('data', onData)
      done(String(chunk).trim())
    }
    process.stdin.resume()
    process.stdin.once('data', onData)
  })
}

// ---------------------------------------------------------------------------
// Install locations
// ---------------------------------------------------------------------------

/** @returns {string[]} candidate `resources` directories, most likely first */
function resourcesCandidates() {
  const out = []
  const push = (value) => {
    if (typeof value === 'string' && value !== '' && !out.includes(value)) out.push(value)
  }
  push(process.env.DSH_RESOURCES)
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    if (local !== undefined && local !== '') push(join(local, 'Programs', 'DeepSeek Harness', 'resources'))
    push('C:\\Program Files\\DeepSeek Harness\\resources')
    push('C:\\Program Files (x86)\\DeepSeek Harness\\resources')
  } else if (process.platform === 'darwin') {
    push('/Applications/DeepSeek Harness.app/Contents/Resources')
    push(join(homedir(), 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources'))
  } else {
    push(join(homedir(), '.local', 'share', 'DeepSeek Harness', 'resources'))
  }
  return out
}

/** @returns {string | undefined} */
function detectResources() {
  for (const candidate of resourcesCandidates()) {
    if (existsSync(join(candidate, 'app.asar'))) return candidate
  }
  return undefined
}

// ---------------------------------------------------------------------------
// asar: parse a header, rebuild the data section, rewrite offsets + integrity
// ---------------------------------------------------------------------------

/**
 * @param {Buffer} buf
 */
function parseAsar(buf) {
  if (buf.length < 16) throw new Error('the archive is too small to be an asar')
  const jsonLength = buf.readUInt32LE(12)
  const start = 16
  if (jsonLength <= 0 || start + jsonLength > buf.length) throw new Error('the asar header is truncated')
  const header = JSON.parse(buf.toString('utf8', start, start + jsonLength))
  const pad = (4 - (jsonLength % 4)) % 4
  const dataStart = start + jsonLength + pad
  return { header, dataStart, data: buf.subarray(dataStart) }
}

/** @param {string} file */
function readAsar(file) {
  return parseAsar(readFileSync(file))
}

/** @param {any} header @returns {{ path: string, node: any }[]} */
function collect(header) {
  const files = []
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files || {})) {
      const path = prefix === '' ? name : prefix + '/' + name
      if (child.files !== undefined) walk(child, path)
      else files.push({ path, node: child })
    }
  }
  walk(header, '')
  return files
}

/** @param {any} data @param {any} node */
function entryBytes(data, node) {
  return data.subarray(Number(node.offset), Number(node.offset) + Number(node.size))
}

/** The sha256 block list Electron validates a packed entry against. */
function integrityFor(content) {
  const blocks = []
  for (let offset = 0; offset < content.length; offset += BLOCK_SIZE) {
    blocks.push(
      createHash('sha256').update(content.subarray(offset, Math.min(offset + BLOCK_SIZE, content.length))).digest('hex'),
    )
  }
  if (blocks.length === 0) blocks.push(createHash('sha256').update(Buffer.alloc(0)).digest('hex'))
  return {
    algorithm: 'SHA256',
    hash: createHash('sha256').update(content).digest('hex'),
    blockSize: BLOCK_SIZE,
    blocks,
  }
}

/**
 * Rebuild the archive with `lib/main.js` rewritten.
 *
 * @param {Buffer} buf the archive to rebuild
 * @param {Array<[string, string]>} rewrites literal `[from, to]` pairs
 * @returns {{ buffer: Buffer, applied: number }}
 */
function rebuild(buf, rewrites) {
  const { header, data } = parseAsar(buf)
  const packed = collect(header)
    .filter((file) => file.node.unpacked !== true)
    .sort((a, b) => Number(a.node.offset) - Number(b.node.offset))

  const chunks = []
  let applied = 0
  let cursor = 0
  let touched = false

  for (const file of packed) {
    let content = entryBytes(data, file.node)
    if (file.path === MAIN_ENTRY) {
      let text = content.toString('utf8')
      for (const [from, to] of rewrites) {
        if (!text.includes(from)) continue
        text = text.split(from).join(to)
        applied += 1
      }
      if (applied === 0) throw new Error('lib/main.js contains none of the expected patch sites')
      content = Buffer.from(text, 'utf8')
      file.node.size = content.length
      file.node.integrity = integrityFor(content)
      touched = true
    }
    file.node.offset = String(cursor)
    chunks.push(content)
    cursor += content.length
  }
  if (!touched) throw new Error('lib/main.js was not found in the archive')

  const headerJson = Buffer.from(JSON.stringify(header), 'utf8')
  const pad = (4 - (headerJson.length % 4)) % 4
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(headerJson.length + 8, 4)
  prefix.writeUInt32LE(headerJson.length + 4, 8)
  prefix.writeUInt32LE(headerJson.length, 12)
  return { buffer: Buffer.concat([prefix, headerJson, Buffer.alloc(pad), Buffer.concat(chunks)]), applied }
}

/**
 * Prove a rebuilt archive differs from its source only where it must: the same
 * entries, every untouched file byte-identical, `lib/main.js` in the expected
 * state.
 *
 * @param {Buffer} before the archive the rebuild started from
 * @param {Buffer} after the rebuilt archive
 * @param {(text: string) => boolean} ok
 * @returns {number} how many files were compared and matched
 */
function verify(before, after, ok) {
  const from = parseAsar(before)
  const to = parseAsar(after)
  const beforeFiles = collect(from.header)
  const afterFiles = collect(to.header)
  if (beforeFiles.length !== afterFiles.length) {
    throw new Error(`entry count changed: ${beforeFiles.length} -> ${afterFiles.length}`)
  }
  const byPath = new Map(beforeFiles.map((file) => [file.path, file]))
  let compared = 0
  for (const file of afterFiles) {
    const original = byPath.get(file.path)
    if (original === undefined) throw new Error('a new entry appeared: ' + file.path)
    const next = entryBytes(to.data, file.node)
    if (file.path === MAIN_ENTRY) {
      if (!ok(next.toString('utf8'))) throw new Error('lib/main.js is not in the expected state after the rebuild')
      continue
    }
    if (file.node.unpacked === true || original.node.unpacked === true) {
      if (Number(file.node.size) !== Number(original.node.size)) throw new Error('size drifted on ' + file.path)
      continue
    }
    if (!entryBytes(from.data, original.node).equals(next)) {
      throw new Error('an untouched file changed: ' + file.path)
    }
    compared += 1
  }
  return compared
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @param {Buffer} buf */
function mainTextOf(buf) {
  const { header, data } = parseAsar(buf)
  const file = collect(header).find((entry) => entry.path === MAIN_ENTRY)
  if (file === undefined) throw new Error('the archive has no ' + MAIN_ENTRY + '; the shell layout changed')
  return entryBytes(data, file.node).toString('utf8')
}

/**
 * @param {string} resources
 * @returns {{ archive: string, patched: boolean, patchSite: boolean, cachePatched: boolean, bytes: number }}
 */
function inspect(resources) {
  const archive = join(resources, 'app.asar')
  if (!existsSync(archive)) throw new Error('there is no app.asar in ' + resources)
  const main = mainTextOf(readFileSync(archive))
  return {
    archive,
    patched: main.includes(PATCH_MARK),
    patchSite: main.includes(PERSIST_FROM),
    cachePatched: main.includes(CACHE_MARK),
    bytes: statSync(archive).size,
  }
}

/**
 * Whether the backup on disk is a genuine unpatched archive.
 *
 * @param {string} resources
 * @returns {'clean' | 'dirty' | 'missing'}
 */
function backupState(resources) {
  const backup = join(resources, BACKUP)
  if (!existsSync(backup)) return 'missing'
  try {
    return mainTextOf(readFileSync(backup)).includes(PATCH_MARK) ? 'dirty' : 'clean'
  } catch (error) {
    void error
    return 'dirty'
  }
}

/** @param {string} dir */
function canWrite(dir) {
  const probe = join(dir, '.dsh-chat-embed-write-probe')
  try {
    writeFileSync(probe, 'x')
    unlinkSync(probe)
    return true
  } catch (error) {
    void error
    return false
  }
}

// ---------------------------------------------------------------------------
// Swapping the archive in, around a running app
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise((done) => setTimeout(done, ms))

/** @param {unknown} error @returns {boolean} */
function isBusy(error) {
  const code =
    error !== null && error !== undefined && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ETXTBSY'
}

/**
 * Replace `archive` with `staged`, keeping the old archive at `keepAs` (or
 * deleting it when `keepAs` is undefined).
 *
 * A running DSH holds the archive memory-mapped. On Windows that blocks the
 * rename, so the script waits for the app to exit and says so; on macOS and
 * Linux the rename succeeds and the change takes effect at the next launch.
 *
 * @param {string} archive
 * @param {string} staged
 * @param {string | undefined} keepAs
 */
async function swapIn(archive, staged, keepAs) {
  const parked = archive + '.prev'
  let waitedSince = 0
  for (;;) {
    try {
      if (existsSync(parked)) unlinkSync(parked)
      renameSync(archive, parked)
    } catch (error) {
      if (!isBusy(error)) throw error
      const now = Date.now()
      if (waitedSince === 0) {
        waitedSince = now
        say('')
        say('  DSH 正在运行，app.asar 被它占用。')
        say('  请完全退出 DSH（托盘 →「退出」），脚本会在这里等待并自动继续。')
        say('')
      } else if (now - waitedSince > 8000) {
        waitedSince = now
        say('  仍在等待 DSH 退出 …')
      }
      await delay(700)
      continue
    }

    try {
      renameSync(staged, archive)
    } catch (error) {
      try {
        renameSync(parked, archive)
      } catch (restoreError) {
        void restoreError
      }
      throw error
    }

    if (keepAs === undefined) {
      try {
        unlinkSync(parked)
      } catch (error) {
        void error
      }
    } else {
      try {
        if (existsSync(keepAs)) unlinkSync(keepAs)
        renameSync(parked, keepAs)
      } catch (error) {
        // The swap already happened; a stranded copy is not a failure.
        say('  · 旧版本没能另存为 ' + keepAs + '：' + reasonOf(error))
      }
    }
    return
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** @param {string} resources */
function status(resources) {
  const state = inspect(resources)
  const backup = backupState(resources)
  say('  安装目录   ' + resources)
  say('  系统       ' + process.platform + ' / node ' + process.version)
  say('  app.asar   ' + plural(state.bytes))
  say(
    '  当前状态   ' +
      (state.patched ? '已开启（persist: 分区）' : state.patchSite ? '未开启（内存分区）' : '补丁点不存在，脚本该更新了'),
  )
  say(
    '  原版备份   ' +
      (backup === 'clean' ? '有，干净' : backup === 'dirty' ? '有，但本身是补丁版（还原不依赖它）' : '无'),
  )
  say('  可写       ' + (canWrite(resources) ? '是' : '否，需要管理员权限'))
  return state.patched || state.patchSite ? 0 : 1
}

/**
 * @param {string} resources
 * @param {{ cachePatch: boolean }} options
 */
async function apply(resources, options) {
  const state = inspect(resources)
  if (state.patched) {
    say('  已经开启，无需操作。')
    return 0
  }
  if (!state.patchSite) {
    say('  ✗ 这个桌面壳版本里找不到补丁点。')
    say('    壳的分区写法变了，本脚本需要更新。未改动任何文件。')
    return 1
  }

  say('  正在生成补丁后的 app.asar …')
  const original = readFileSync(state.archive)
  const rewrites = [[PERSIST_FROM, PERSIST_TO]]
  if (options.cachePatch) rewrites.push([CACHE_FROM, CACHE_TO])
  const built = rebuild(original, rewrites)
  const compared = verify(original, built.buffer, (text) => text.includes(PATCH_MARK))
  say(`  ✓ 校验通过：${compared} 个文件逐字节一致，只有 ${MAIN_ENTRY} 变了`)

  const staged = join(resources, STAGED)
  writeFileSync(staged, built.buffer)

  // Park a pristine copy the first time. A backup that is itself patched is
  // worthless as a restore point, so it never gets to overwrite a clean one.
  const keep = backupState(resources) === 'clean' ? undefined : join(resources, BACKUP)
  await swapIn(state.archive, staged, keep)
  if (keep !== undefined) say('  ✓ 原版已留作 ' + BACKUP)
  changed = true
  return 0
}

/**
 * @param {string} resources
 */
async function revert(resources) {
  const state = inspect(resources)
  if (!state.patched) {
    say('  本来就没打补丁，无需还原。')
    return 0
  }

  // Undo the literals rather than restoring a file: the archive in front of us
  // is the only thing that says what is actually there. The cache rewrite is
  // part of the patch, so leaving it behind would keep an 18-byte scar that
  // every future comparison would trip over.
  say('  正在还原 …')
  const original = readFileSync(state.archive)
  const undo = [[PERSIST_TO, PERSIST_FROM]]
  if (state.cachePatched) undo.push([CACHE_TO, CACHE_FROM])
  let built
  try {
    built = rebuild(original, undo)
  } catch (error) {
    say('  ✗ 无法从当前文件还原：' + reasonOf(error))
    say('    未改动任何文件。')
    return 1
  }
  let compared
  try {
    compared = verify(
      original,
      built.buffer,
      (text) => !text.includes(PATCH_MARK) && !text.includes(CACHE_MARK) && text.includes(PERSIST_FROM),
    )
  } catch (error) {
    say('  ✗ 校验失败：' + reasonOf(error))
    say('    未改动任何文件。')
    return 1
  }
  say(`  ✓ 校验通过：${compared} 个文件逐字节一致`)

  const staged = join(resources, STAGED)
  writeFileSync(staged, built.buffer)
  await swapIn(state.archive, staged, join(resources, PATCHED_COPY))
  say('  ✓ 补丁版已留作 ' + PATCHED_COPY)
  changed = true
  return 0
}

// ---------------------------------------------------------------------------
// Cache cleanup (the other half of the persistent partition)
// ---------------------------------------------------------------------------

/** Directories Chromium recreates on demand; the login never lives in them. */
const CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'ShaderCache',
  'Shared Dictionary',
]

/** @returns {string[]} candidate Partitions directories */
function partitionsCandidates() {
  const out = []
  const push = (value) => {
    if (typeof value === 'string' && value !== '' && !out.includes(value)) out.push(value)
  }
  push(process.env.DSH_PARTITIONS)
  const appData =
    process.platform === 'win32'
      ? process.env.APPDATA
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME !== undefined && process.env.XDG_CONFIG_HOME !== ''
          ? process.env.XDG_CONFIG_HOME
          : join(homedir(), '.config')
  if (appData !== undefined && appData !== '') {
    push(join(appData, '@deepseek-ai', 'dsh-desktop', 'Partitions'))
    push(join(appData, 'DeepSeek Harness', 'Partitions'))
  }
  return out
}

/** @param {string} dir @returns {number} bytes under it */
function sizeOf(dir) {
  let total = 0
  const walk = (path) => {
    let entries
    try {
      entries = readdirSync(path, { withFileTypes: true })
    } catch (error) {
      void error
      return
    }
    for (const entry of entries) {
      const next = join(path, entry.name)
      if (entry.isDirectory()) walk(next)
      else {
        try {
          total += statSync(next).size
        } catch (error) {
          void error
        }
      }
    }
  }
  walk(dir)
  return total
}

/**
 * Free the disposable Chromium caches, keep the login.
 *
 * The persistent partition is what makes a login survive a restart; it also
 * means a Chromium profile stays on disk, most of which is cache. Cookies,
 * Local Storage and IndexedDB — where a signed-in service actually lives — are
 * never touched here.
 */
function cleanCache() {
  const base = partitionsCandidates().find((candidate) => existsSync(candidate))
  if (base === undefined) {
    say('  没有找到 Partitions 目录，无需清理。')
    say('  找过这些位置：')
    for (const candidate of partitionsCandidates()) say('    ' + candidate)
    return 1
  }
  say('  如果 DSH 正在运行，部分文件会被占用；关掉它再运行一次更彻底。')
  say('')
  const before = sizeOf(base)
  let freed = 0
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const partition = join(base, entry.name)
    for (const name of CACHE_DIRS) {
      const target = join(partition, name)
      if (!existsSync(target)) continue
      const size = sizeOf(target)
      try {
        rmSync(target, { recursive: true, force: true })
        if (!existsSync(target)) freed += size
      } catch (error) {
        say('  · ' + entry.name + '/' + name + ' 没删掉：' + reasonOf(error))
      }
    }
  }
  const after = sizeOf(base)
  say('  ' + base)
  say('  释放 ' + plural(freed) + '，剩余 ' + plural(after) + '（清理前 ' + plural(before) + '）')
  say('  登录状态、Cookie、LocalStorage 均未改动。')
  return 0
}

// ---------------------------------------------------------------------------
// Elevation
// ---------------------------------------------------------------------------

/**
 * Re-run this script with administrator rights, waiting for it to finish.
 *
 * @param {string[]} argv the original arguments
 * @returns {boolean} whether an elevated run completed successfully
 */
function relaunchElevated(argv) {
  const args = [SELF, ...argv]
  try {
    if (process.platform === 'win32') {
      const list = args.map((value) => `'${value.replace(/'/g, "''")}'`).join(',')
      const command = `Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}' -ArgumentList @(${list}) -Verb RunAs -Wait`
      const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        stdio: 'inherit',
      })
      return result.status === 0
    }
    if (process.platform === 'darwin') {
      const command = args.map((value) => `'${value.replace(/'/g, "'\\''")}'`).join(' ')
      const script = `do shell script "${process.execPath} ${command.replace(/"/g, '\\"')}" with administrator privileges`
      const result = spawnSync('osascript', ['-e', script], { stdio: 'inherit' })
      return result.status === 0
    }
  } catch (error) {
    void error
  }
  return false
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = { action: 'menu', resources: undefined, yes: false, cachePatch: true, elevated: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === 'apply' || arg === 'on') options.action = 'apply'
    else if (arg === 'revert' || arg === 'off') options.action = 'revert'
    else if (arg === 'status') options.action = 'status'
    else if (arg === 'cache') options.action = 'cache'
    else if (arg === '--resources') options.resources = argv[++index]
    else if (arg === '--yes' || arg === '-y') options.yes = true
    else if (arg === '--no-cache-patch') options.cachePatch = false
    else if (arg === '--elevated') options.elevated = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else {
      console.error('unknown argument: ' + arg)
      options.help = true
    }
  }
  return options
}

function usage() {
  say('')
  say('  DSH「重启保持登录」补丁 — 安装或撤掉')
  say('')
  say('  node shell-patch.mjs [status|apply|revert] [选项]')
  say('')
  say('    status   只报告状态，不改动任何文件')
  say('    apply    开启：让内嵌聊天的登录跨重启保留')
  say('    revert   关闭：还原原版 app.asar')
  say('    cache    清理聊天页的缓存（登录保留）')
  say('    （不带命令时打开菜单）')
  say('')
  say('    --resources <dir>  指定含 app.asar 的安装目录')
  say('    --yes              不询问，直接执行')
  say('    --no-cache-patch   保留磁盘缓存，只让分区持久')
  say('')
  say('  改完请重新打开 DSH 使其生效。')
  say('')
}

/**
 * @param {string} resources
 * @param {{ cachePatch: boolean, yes: boolean }} options
 */
async function menu(resources, options) {
  const state = inspect(resources)
  say('')
  say('  安装目录：' + resources)
  say('  当前状态：' + (state.patched ? '已开启' : state.patchSite ? '未开启' : '补丁点不存在，脚本该更新了'))
  say('')
  say('    1) 开启')
  say('    2) 关闭')
  say('    3) 只看状态')
  say('    4) 清理缓存（登录保留）')
  say('    0) 退出')
  say('')
  const choice = await ask('选择 [0-4]:')
  if (choice === '' || choice === '3') return status(resources)
  if (choice === '0') return 0
  if (choice === '1') {
    if (state.patched) {
      say('  已经开启，无需操作。')
      return 0
    }
    say('')
    say('  这会改写 DSH 桌面版的 app.asar。DSH 升级会覆盖它，到时再运行一次即可。')
    const answer = options.yes ? 'y' : await ask('  继续？[y/N]')
    if (answer.toLowerCase() !== 'y') {
      say('  已取消。')
      return 0
    }
    return apply(resources, options)
  }
  if (choice === '2') {
    if (!state.patched) {
      say('  本来就没打补丁，无需还原。')
      return 0
    }
    const answer = options.yes ? 'y' : await ask('  关闭后每次重启都要重新登录。继续？[y/N]')
    if (answer.toLowerCase() !== 'y') {
      say('  已取消。')
      return 0
    }
    return revert(resources)
  }
  if (choice === '4') return cleanCache()
  say('  没有这个选项。')
  return 1
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    usage()
    return 0
  }

  // The cache lives under the app's user data, not beside app.asar, so this
  // one command does not need an install directory at all.
  if (options.action === 'cache') {
    say('')
    say('  DSH 聊天页缓存清理')
    return cleanCache()
  }

  const resources = options.resources !== undefined ? resolve(options.resources) : detectResources()
  if (resources === undefined) {
    say('')
    say('  ✗ 没有找到 DSH 安装目录。常见位置：')
    for (const candidate of resourcesCandidates()) say('      ' + candidate)
    say('')
    say('    装在别处请传进来：')
    say('      node shell-patch.mjs apply --resources "<安装目录>/resources"')
    say('')
    return 1
  }
  if (!existsSync(join(resources, 'app.asar'))) {
    say('')
    say('  ✗ ' + resources + ' 里没有 app.asar，不像是 DSH 的安装目录。')
    say('')
    return 1
  }

  // Anything that writes needs the directory to accept a file. Ask for
  // elevation up front rather than halfway through a swap.
  const writing = options.action === 'apply' || options.action === 'revert' || options.action === 'menu'
  if (writing && !options.elevated && !canWrite(resources)) {
    say('')
    say('  安装目录不可写，需要管理员权限。正在请求提权 …')
    if (relaunchElevated(process.argv.slice(2))) return 0
    say('')
    say('  ✗ 没能提权。请手动以管理员身份运行：')
    if (process.platform === 'win32') say('    右键 shell-patch.cmd →「以管理员身份运行」')
    else say('    sudo node "' + SELF + '" ' + (options.action === 'menu' ? '' : options.action))
    say('')
    return 1
  }

  say('')
  say('  DSH「重启保持登录」补丁')

  let code
  if (options.action === 'status') code = status(resources)
  else if (options.action === 'apply') code = await apply(resources, options)
  else if (options.action === 'revert') code = await revert(resources)
  else if (options.action === 'cache') code = cleanCache()
  else code = await menu(resources, options)

  if (code === 0 && changed) {
    say('')
    say('  ──────────────────────────────────────')
    say('  ✓ 完成。请重新打开 DSH 使其生效。')
    say('  ──────────────────────────────────────')
  }
  say('')
  return code
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    say('')
    say('  ✗ ' + reasonOf(error))
    say('')
    process.exitCode = 1
  },
)
