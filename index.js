/**
 * dsh-chat-embed — Host half.
 *
 * The feature itself lives in the Client half (`client.js`): the desktop
 * webview, the lease handshake, the panel UI. This half exists for two
 * reasons, and nothing else:
 *
 *   1. the loader row named by `cordis.patch.yml` needs a Node-side export;
 *   2. the optional shell patch needs a **Host-side** answer, because the
 *      patched archive lives on the Host's disk and only the Host can read
 *      and test it. The panel asks over the exposed channel, so the dialog can
 *      name the exact script to run instead of guessing a path;
 *   3. the same switch has to *start* that script, and only a Node process can.
 *      The Host spawns it and nothing else: every byte written to the shell is
 *      written by `tools/shell-patch/shell-patch.mjs`, never by this module.
 *
 * Keep this module inert beyond that probe. It must not import browser
 * globals, and anything it registers must be cleaned up through `ctx.effect`
 * so uninstalling the bundle leaves the Host process exactly as it was.
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-chat-embed'

/**
 * Wait for the web server before apply runs.
 *
 * Without this the loader calls apply while the tree is still assembling, the
 * lookup below reads undefined, and the probe route is silently skipped — which
 * is exactly what happened until 0.6.10.
 */
export const inject = ['webServer']

/** Route the panel fetches for the read-only shell probe. */
const PROBE_PATH = '/dsh-chat-embed/patch-check'

/**
 * Route the panel asks to actually run the patch script.
 *
 * A GET, not a POST: the carrier behind these routes answers GET and HEAD only
 * and replies 405 to every other method before the handler runs
 * (`@deepseek-ai/dsh-host-webserver`, `serveResource`). What protects the state
 * change is a token instead — minted once per Host process, handed out only
 * inside the probe body, unguessable, and unreadable from another origin
 * because this server sends no CORS headers.
 */
const PATCH_PATH = '/dsh-chat-embed/patch'

/** Query parameters of the action route. */
const ACTION_PARAM = 'action'
const TOKEN_PARAM = 'token'

/** The one token this Host process accepts. */
const PATCH_TOKEN = randomUUID().replace(/-/g, '')

/** Strings that identify the patch in a rebuilt archive. */
const PATCH_MARK = 'persist:dsh-sidebar-'
const CACHE_MARK = '{ cache: false }'

/** Strings that identify an unpatched archive's patch sites. */
const PATCH_SITE_MARK = 'partition = `dsh-sidebar-browser-'
const CACHE_SITE_MARK = 'this.configureSession(session.fromPartition(partition))'

/**
 * Candidate `resources` directories. `DSH_RESOURCES` wins so a custom install
 * or a non-Windows layout can be pointed at explicitly.
 *
 * @returns {string[]} absolute candidates, most specific first
 */
function resourcesCandidates() {
  const candidates = []
  // Electron hands the running app its own resources directory: the exact
  // answer, and the only one that works for a non-standard install location.
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    candidates.push(process.resourcesPath)
  }
  // A plain Node process started beside the app binary can derive it.
  if (typeof process.execPath === 'string' && process.execPath !== '') {
    candidates.push(join(dirname(process.execPath), 'resources'))
  }
  candidates.push(process.env.DSH_RESOURCES)
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData !== undefined && localAppData !== '') {
      candidates.push(join(localAppData, 'Programs', 'DeepSeek Harness', 'resources'))
    }
    candidates.push('C:\\Program Files\\DeepSeek Harness\\resources')
    candidates.push('C:\\Program Files (x86)\\DeepSeek Harness\\resources')
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources')
  } else {
    candidates.push('/opt/DeepSeek Harness/resources')
    candidates.push(join(homedir(), 'DeepSeek Harness', 'resources'))
  }
  return candidates.filter((entry) => typeof entry === 'string' && entry !== '')
}

/** @returns {string | undefined} the directory that actually holds app.asar */
function detectResources() {
  for (const candidate of resourcesCandidates()) {
    if (existsReal(join(candidate, 'app.asar'))) return candidate
  }
  return undefined
}

/**
 * Electron's unpatched file system, when this process is running on it.
 *
 * `node:fs` inside Electron treats any `*.asar` path as an archive: the archive
 * file itself reads as ENOENT, `statSync` reports 0 and `existsSync` says false.
 * Every question this half asks about the shell archive has to go through the
 * unpatched binding, or the probe answers "there is no install here" on a
 * machine that has one. A plain Node has no `original-fs` and needs none.
 */
const ORIGINAL_FS = (() => {
  try {
    const original = createRequire(import.meta.url)('original-fs')
    if (original !== undefined && original !== null && typeof original.readFileSync === 'function') return original
  } catch (error) {
    void error
  }
  return undefined
})()

/** @param {string} file @returns {boolean} */
function existsReal(file) {
  try {
    if (ORIGINAL_FS !== undefined && typeof ORIGINAL_FS.existsSync === 'function') {
      return ORIGINAL_FS.existsSync(file) === true
    }
    return existsSync(file)
  } catch (error) {
    void error
    return false
  }
}

/** @param {string} file @returns {boolean} */
function isWritable(file) {
  try {
    if (ORIGINAL_FS !== undefined && typeof ORIGINAL_FS.accessSync === 'function') {
      ORIGINAL_FS.accessSync(file, constants.W_OK)
      return true
    }
    accessSync(file, constants.W_OK)
    return true
  } catch (error) {
    void error
    return false
  }
}

/**
 * Read a file with the real Node implementation.
 *
 * Inside Electron the `node:fs` binding is patched to treat a path ending in
 * `.asar` as a directory, so `readFileSync('<install>/app.asar')` raises ENOENT
 * even though the bytes are all there. `original-fs` is Electron's unpatched
 * copy; outside Electron the ordinary binding is already literal and is used.
 *
 * @param {string} file
 * @returns {Buffer}
 */
function readRealFile(file) {
  if (ORIGINAL_FS !== undefined) return ORIGINAL_FS.readFileSync(file)
  return readFileSync(file)
}

/** @param {string} file @returns {number} the real byte length */
function statRealSize(file) {
  if (ORIGINAL_FS !== undefined && typeof ORIGINAL_FS.statSync === 'function') {
    return ORIGINAL_FS.statSync(file).size
  }
  return statSync(file).size
}

/**
 * Read one entry out of an asar archive.
 *
 * The container is `u32 @0 = 4`, `u32 @4 = headerLen + 8`, `u32 @8 = headerLen + 4`,
 * `u32 @12 = headerLen`, then the JSON header, padding, then the file data.
 *
 * @param {string} file
 * @param {string} entry slash-separated path inside the archive
 * @returns {string | undefined} the entry as UTF-8, or undefined when absent
 */
function readAsarEntry(file, entry) {
  const buffer = readRealFile(file)
  const headerLength = buffer.readUInt32LE(12)
  const header = JSON.parse(buffer.toString('utf8', 16, 16 + headerLength))
  const padding = (4 - (headerLength % 4)) % 4
  const dataStart = 16 + headerLength + padding
  let node = header
  for (const segment of entry.split('/')) {
    if (node === undefined || node.files === undefined) return undefined
    node = node.files[segment]
  }
  if (node === undefined || node.files !== undefined) return undefined
  if (node.unpacked === true) return undefined
  const offset = dataStart + Number(node.offset)
  return buffer.toString('utf8', offset, offset + Number(node.size))
}

/**
 * The command line for one direction of the patch.
 *
 * The launcher is what a user double-clicks: it opens a window that stays open
 * and finds Node by itself. Windows and macOS ship one; every other platform
 * gets the equivalent `node <script>` line, because the script itself is
 * platform-neutral and there is no desktop build to point at.
 *
 * @param {'apply' | 'revert'} action
 * @param {{ launcher?: string, script?: string }} files
 * @param {string} [nodeBinary] path to a Node binary, for the fallback
 * @returns {string | undefined}
 */
function launcherCommand(action, files, nodeBinary) {
  const quote = (value) => (value.includes(' ') ? '"' + value + '"' : value)
  if (typeof files.launcher === 'string' && files.launcher !== '') return quote(files.launcher) + ' ' + action
  if (typeof files.script !== 'string' || files.script === '') return undefined
  const node =
    typeof nodeBinary === 'string' && nodeBinary !== '' ? quote(nodeBinary) : 'node'
  return node + ' ' + quote(files.script) + ' ' + action
}

/**
 * Locate a Node binary for the non-desktop fallback. The desktop app ships its
 * own runtime under `dsh-runtimes`; a plain install just uses PATH.
 *
 * @returns {string | undefined}
 */
function findNodeBinary() {
  const candidates = []
  if (typeof process.execPath === 'string' && /node(\.exe)?$/i.test(process.execPath)) candidates.push(process.execPath)
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const runtimes = join(home, 'dsh-runtimes')
  try {
    for (const entry of readdirSync(runtimes)) {
      candidates.push(join(runtimes, entry, 'dependencies', 'node', 'bin', 'node'))
    }
  } catch (error) {
    void error
  }
  if (process.platform === 'win32' && process.env.ProgramFiles !== undefined) {
    candidates.push(join(process.env.ProgramFiles, 'nodejs', 'node.exe'))
  } else {
    candidates.push('/usr/local/bin/node', '/usr/bin/node')
  }
  return candidates.find((candidate) => typeof candidate === 'string' && candidate !== '' && existsSync(candidate))
}

/**
 * Locate the patch entry point inside this package, so what the panel offers
 * points at files that actually exist on the user's disk.
 *
 * @returns {{ script?: string, launcher?: string }}
 */
function findPatchFiles() {
  const here = dirname(fileURLToPath(import.meta.url))
  const dir = join(here, 'tools', 'shell-patch')
  const script = join(dir, 'shell-patch.mjs')
  const launcher =
    process.platform === 'win32'
      ? join(dir, 'shell-patch.cmd')
      : process.platform === 'darwin'
        ? join(dir, 'shell-patch.command')
        : undefined
  return {
    script: existsSync(script) ? script : undefined,
    launcher: launcher !== undefined && existsSync(launcher) ? launcher : undefined,
  }
}

/**
 * Inspect the desktop shell and the optional patch. Read-only: no file here is
 * written, so this is safe to call from a diagnostics button.
 *
 * @param {string} [resources]
 * @returns {object} a report the panel formats and copies
 */
function inspectShell(resources) {
  const explicit = typeof resources === 'string' && resources !== ''
  const resolved = explicit ? resources : detectResources()
  if (resolved === undefined) {
    return {
      found: false,
      platform: process.platform,
      node: process.version,
      detail: '没有找到 DSH 安装目录；用 DSH_RESOURCES 或 --resources 指定',
    }
  }
  const asar = join(resolved, 'app.asar')
  if (!existsReal(asar)) {
    return {
      found: false,
      platform: process.platform,
      node: process.version,
      resources: resolved,
      asar,
      detail: '该目录下没有 app.asar；路径不对，或桌面壳安装不完整',
    }
  }
  const staged = join(resolved, 'app.asar.new')
  const backup = join(resolved, 'app.asar.orig')
  const report = {
    found: true,
    platform: process.platform,
    node: process.version,
    resources: resolved,
    asar,
    exists: true,
    // The swap renames the archive inside its own directory and stages a new
    // one beside it, so the directory is what has to be writable.
    writable: isWritable(resolved),
    backup: existsSync(backup),
    // A backup that is itself patched cannot restore anything, and reporting it
    // as "present" is exactly what made a rollback look available when it was
    // not. Say which kind it is.
    backupClean: undefined,
    staged: existsSync(staged),
    patched: undefined,
    patchSite: undefined,
    detail: '',
  }
  try {
    report.asarBytes = statRealSize(asar)
    report.asarHash = createHash('sha256').update(readRealFile(asar)).digest('hex').slice(0, 16)
  } catch (error) {
    report.detail = '读取 app.asar 失败：' + firstLine(error)
    return report
  }
  try {
    const main = readAsarEntry(asar, 'lib/main.js')
    if (main === undefined) {
      report.detail = 'app.asar 中找不到 lib/main.js；壳结构已变化'
      return report
    }
    report.patched = main.includes(PATCH_MARK)
    report.cachePatch = main.includes(CACHE_MARK)
    if (report.backup === true) {
      try {
        const copy = readAsarEntry(backup, 'lib/main.js')
        report.backupClean = copy !== undefined && !copy.includes(PATCH_MARK)
      } catch (error) {
        void error
        report.backupClean = false
      }
    }
    report.patchSite = main.includes(PATCH_SITE_MARK) || main.includes(PATCH_MARK)
    if (report.patched !== true && report.patchSite === false) {
      report.detail = '补丁点不存在：当前桌面壳版本的分区写法与补丁预期不一致，需要更新补丁'
    } else if (report.patched !== true && report.cachePatch !== true) {
      report.detail = '尚未打补丁'
    }
  } catch (error) {
    report.detail = '解析 app.asar 失败：' + firstLine(error)
  }
  // The patch is one script with one command for each direction. The launcher
  // is what the user double-clicks; it finds Node on its own, so the panel never
  // has to talk about runtimes.
  const files = findPatchFiles()
  const node = findNodeBinary()
  report.script = files.script
  report.launcher = files.launcher
  report.nodeBinary = node
  report.applyCommand = launcherCommand('apply', files, node)
  report.revertCommand = launcherCommand('revert', files, node)
  return report
}

/** @param {unknown} error @returns {string} */
function firstLine(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.split('\n')[0].slice(0, 200)
}

/** @param {unknown} body @param {number} [status] @returns {Response} */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * What the switch asked for, and whether it can happen without the user falling
 * back to the copyable command.
 *
 * Pure: it reads the probe report and decides. Nothing here writes anything —
 * the script is the only thing in this package that ever does.
 *
 * @param {string} action 'apply' or 'revert'
 * @param {object} report the probe's answer
 * @returns {{ state: string, detail: string, command: string }}
 */
function planPatchAction(action, report) {
  const wantsOn = action === 'apply'
  if (report === undefined || report === null || report.found !== true) {
    return { state: 'noapp', detail: '没有找到 DSH 安装目录；Web 端没有桌面壳可以打补丁', command: '' }
  }
  const command = (wantsOn ? report.applyCommand : report.revertCommand) ?? ''
  if (report.patched !== true && report.patched !== false) {
    return { state: 'failed', detail: report.detail === '' ? '无法判断 app.asar 的当前状态' : report.detail, command }
  }
  if (report.patched === wantsOn) {
    return { state: 'same', detail: wantsOn ? 'app.asar 已经是补丁版' : 'app.asar 已经是原版', command }
  }
  if (report.patchSite === false) {
    return { state: 'unsupported', detail: '当前桌面壳的分区写法与补丁不一致，脚本也需要更新', command }
  }
  if (report.writable !== true) {
    return { state: 'denied', detail: '安装目录不可写，需要管理员权限', command }
  }
  if (typeof report.script !== 'string' || report.script === '') {
    return { state: 'failed', detail: '找不到补丁脚本（tools/shell-patch）', command }
  }
  return { state: 'started', detail: '', command }
}

/**
 * The program to run the script with, and to start DSH again with afterwards.
 *
 * In the desktop app the Host is a child of the shell launched from the shell's
 * own Electron binary in Node mode, so `process.execPath` is
 * `DeepSeek Harness.exe`: the exact runtime the script wants, and the exact
 * program to relaunch. A plain Node Host is nothing to relaunch, so it yields
 * undefined and the script only asks the user to reopen DSH.
 *
 * @returns {string | undefined}
 */
function selfExecutable() {
  const exec = process.execPath
  if (typeof exec !== 'string' || exec === '') return undefined
  return /^node(\.exe)?$/i.test(basename(exec)) ? undefined : exec
}

/**
 * @param {string} action 'apply' or 'revert'
 * @param {object} report the probe's answer
 * @returns {string[]} the script's arguments
 */
function launchArgs(action, report) {
  const args = [report.script, action, '--restart', '--resources', String(report.resources)]
  // The shell itself: the swap needs it closed, and the script starts it again.
  const pid = Number(process.ppid)
  if (Number.isInteger(pid) && pid > 0) args.push('--pid', String(pid))
  const exe = selfExecutable()
  if (exe !== undefined) args.push('--exe', exe)
  return args
}

/**
 * Start the patch script so that it outlives this process.
 *
 * It has to: the swap waits for DSH to exit, and that exit takes this Host with
 * it. `detached` plus `unref` is what keeps the child alive across that.
 *
 * @param {string} action 'apply' or 'revert'
 * @param {object} report the probe's answer
 * @param {typeof spawn} spawnProcess
 * @returns {import('node:child_process').ChildProcess | undefined}
 */
function spawnPatcher(action, report, spawnProcess) {
  const child = spawnProcess(selfExecutable() ?? process.execPath, launchArgs(action, report), {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  if (child !== null && child !== undefined && typeof child.unref === 'function') child.unref()
  return child
}

/**
 * Serve the probe and the switch action over the Web GUI's HTTP carrier, so the
 * panel can use plain relative `fetch` — no Remote RPC endpoint, no shell
 * bridge, and the same code path in the desktop app and the Web GUI.
 *
 * The probe is read-only and reports where the shell is and what the archive
 * contains. The action route starts the patch script, which waits for DSH to
 * exit and then does the swap and the relaunch; this half never writes a byte.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ inspect?: () => object, spawn?: typeof spawn }} [deps] test seams
 * @returns {(() => void) | undefined} a disposer, or undefined without a webserver
 */
function installHttpRoutes(ctx, deps = {}) {
  const server = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (server === undefined || server === null || typeof server.register !== 'function') return undefined
  const read = typeof deps.inspect === 'function' ? deps.inspect : inspectShell
  const spawnProcess = typeof deps.spawn === 'function' ? deps.spawn : spawn
  /** The patcher this panel started, so a second click replaces it. */
  let waiting

  const stopWaiting = () => {
    if (waiting === undefined) return
    try {
      waiting.kill()
    } catch (error) {
      void error
    }
    waiting = undefined
  }

  const probe = {
    kind: 'exact',
    path: PROBE_PATH,
    resource(request) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
      }
      let body
      try {
        body = JSON.stringify({ ...read(), token: PATCH_TOKEN })
      } catch (error) {
        body = JSON.stringify({ found: false, detail: firstLine(error), token: PATCH_TOKEN })
      }
      return new Response(request.method === 'HEAD' ? null : body, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    },
  }

  const action = {
    kind: 'exact',
    path: PATCH_PATH,
    resource(request) {
      // GET only: a HEAD here would perform the action without returning a body.
      if (request.method !== 'GET') {
        return new Response('method not allowed', { status: 405, headers: { allow: 'GET' } })
      }
      let url
      try {
        url = new URL(request.url)
      } catch (error) {
        return jsonResponse({ ok: false, state: 'bad-request', detail: firstLine(error) }, 400)
      }
      if (url.searchParams.get(TOKEN_PARAM) !== PATCH_TOKEN) {
        return jsonResponse({ ok: false, state: 'forbidden', detail: '缺少或不匹配的 token' }, 403)
      }
      const which = url.searchParams.get(ACTION_PARAM)
      if (which !== 'apply' && which !== 'revert') {
        return jsonResponse({ ok: false, state: 'bad-request', detail: 'action 只能是 apply 或 revert' }, 400)
      }
      let report
      try {
        report = read()
      } catch (error) {
        return jsonResponse({ ok: false, state: 'failed', detail: firstLine(error), command: '' })
      }
      const plan = planPatchAction(which, report)
      if (plan.state !== 'started') {
        return jsonResponse({ ok: false, state: plan.state, detail: plan.detail, command: plan.command })
      }
      stopWaiting()
      try {
        waiting = spawnPatcher(which, report, spawnProcess)
      } catch (error) {
        return jsonResponse({ ok: false, state: 'failed', detail: firstLine(error), command: plan.command })
      }
      return jsonResponse({ ok: true, state: 'started', action: which, command: launchArgs(which, report).join(' ') })
    },
  }

  const disposers = []
  try {
    for (const route of [probe, action]) {
      const dispose = server.register(route)
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  } catch (error) {
    // Another composition already claimed a path, or the carrier rejected the
    // shape. Both routes are optional: the panel still reports local state and
    // still offers the copyable command.
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (ignored) {
        void ignored
      }
    }
    void error
    return undefined
  }
  return () => {
    stopWaiting()
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        void error
      }
    }
  }
}

/**
 * Register the Host-side probe and the action route behind the panel switch.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  if (ctx === undefined || ctx === null || typeof ctx.effect !== 'function') return
  ctx.effect(() => installHttpRoutes(ctx), 'dsh-chat-embed: shell patch routes')
}

/** Exposed for tests and for the patch checker to reuse without a Context. */
export const internals = {
  inspectShell,
  detectResources,
  readAsarEntry,
  readRealFile,
  resourcesCandidates,
  launcherCommand,
  findPatchFiles,
  installHttpRoutes,
  planPatchAction,
  launchArgs,
  selfExecutable,
  PROBE_PATH,
  PATCH_PATH,
  PATCH_TOKEN,
}
