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
 *      name the exact script to run instead of guessing a path.
 *
 * Keep this module inert beyond that probe. It must not import browser
 * globals, and anything it registers must be cleaned up through `ctx.effect`
 * so uninstalling the bundle leaves the Host process exactly as it was.
 */

import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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
    if (existsSync(join(candidate, 'app.asar'))) return candidate
  }
  return undefined
}

/** @param {string} file @returns {boolean} */
function isWritable(file) {
  try {
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
  const fallback = () => readFileSync(file)
  try {
    const original = createRequire(import.meta.url)('original-fs')
    if (original !== undefined && original !== null && typeof original.readFileSync === 'function') {
      return original.readFileSync(file)
    }
  } catch (error) {
    void error
  }
  return fallback()
}

/** @param {string} file @returns {number} the real byte length */
function statRealSize(file) {
  try {
    const original = createRequire(import.meta.url)('original-fs')
    if (original !== undefined && original !== null && typeof original.statSync === 'function') {
      return original.statSync(file).size
    }
  } catch (error) {
    void error
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
 * The launcher the user double-clicks, and the command line that does the same
 * thing in a terminal. Both end up in the same script; the launcher adds a
 * window that stays open and finds Node by itself.
 *
 * @param {'apply' | 'revert'} action
 * @param {string} [launcher] absolute path to the platform launcher
 * @returns {string | undefined}
 */
function launcherCommand(action, launcher) {
  if (typeof launcher !== 'string' || launcher === '') return undefined
  return launcher.includes(' ') ? '"' + launcher + '" ' + action : launcher + ' ' + action
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
  if (!existsSync(asar)) {
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
    writable: existsSync(asar) ? isWritable(asar) : isWritable(resolved),
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
  report.script = files.script
  report.launcher = files.launcher
  report.applyCommand = launcherCommand('apply', files.launcher)
  report.revertCommand = launcherCommand('revert', files.launcher)
  return report
}

/** @param {unknown} error @returns {string} */
function firstLine(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.split('\n')[0].slice(0, 200)
}

/**
 * Serve the read-only probe over the Web GUI's HTTP carrier, so the panel can
 * read it with a plain relative `fetch` — no Remote RPC endpoint, no shell
 * bridge, and the same code path in the desktop app and the Web GUI.
 *
 * The route is GET-only and writes nothing; it reports where the shell is and
 * what the archive contains, which is what a user needs to file a useful bug
 * report when cross-restart login stops working.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {(() => void) | undefined} a disposer, or undefined without a webserver
 */
function installHttpProbe(ctx) {
  const server = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (server === undefined || server === null || typeof server.register !== 'function') return undefined
  const route = {
    kind: 'exact',
    path: PROBE_PATH,
    resource(request) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('method not allowed', { status: 405 })
      }
      let body
      try {
        body = JSON.stringify(inspectShell())
      } catch (error) {
        body = JSON.stringify({ found: false, detail: firstLine(error) })
      }
      return new Response(request.method === 'HEAD' ? null : body, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    },
  }
  try {
    const dispose = server.register(route)
    return typeof dispose === 'function' ? dispose : () => {}
  } catch (error) {
    // Another composition already claimed the path, or the carrier rejected the
    // shape. The probe is optional: the panel still reports the local state.
    void error
    return undefined
  }
}

/**
 * Register the Host-side patch probe and the agent tool.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  if (ctx === undefined || ctx === null || typeof ctx.effect !== 'function') return
  ctx.effect(() => installHttpProbe(ctx), 'dsh-chat-embed: shell patch probe')
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
  PROBE_PATH,
}
