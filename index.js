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
 *      and test it. The panel asks over the exposed channel, so a user can
 *      see why cross-restart login is off without being told to run a
 *      command and read its output.
 *
 * Keep this module inert beyond that probe. It must not import browser
 * globals, and anything it registers must be cleaned up through `ctx.effect`
 * so uninstalling the bundle leaves the Host process exactly as it was.
 */

import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-chat-embed'

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
 * Locate a Node binary that can run the patch tool.
 *
 * DSH runs every profile on its own packaged runtime, so the archive can be
 * patched without the user installing Node. The order is: the runtime this
 * Host is already running on, the managed runtime directory, then a system
 * `node` on PATH.
 *
 * @returns {string | undefined} an absolute path, or undefined when none exists
 */
function findNodeBinary() {
  const candidates = []
  // A Node-hosted dsh reports its own executable.
  if (typeof process.execPath === 'string' && process.execPath !== '' && /node(.exe)?$/i.test(process.execPath)) {
    candidates.push(process.execPath)
  }
  // The managed runtime the desktop app installs beside its own data.
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const runtimes = join(home, 'dsh-runtimes')
  try {
    for (const entry of readdirSync(runtimes)) {
      const base = join(runtimes, entry, 'dependencies', 'node', 'bin')
      candidates.push(join(base, process.platform === 'win32' ? 'node.exe' : 'node'))
    }
  } catch (error) {
    void error
  }
  if (process.platform === 'win32' && process.env.ProgramFiles !== undefined) {
    candidates.push(join(process.env.ProgramFiles, 'nodejs', 'node.exe'))
  } else {
    candidates.push('/usr/local/bin/node')
    candidates.push('/usr/bin/node')
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '' && existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * @param {string} node absolute path to a Node binary
 * @param {string} script absolute path to patch-asar.cjs
 * @param {string} [resources] install directory, so a non-standard location works
 * @returns {string} a copy-pasteable command line
 */
function patchCommand(node, script, resources) {
  const quote = (value) => (value.includes(' ') ? '"' + value + '"' : value)
  const parts = [quote(node), quote(script), 'build']
  // The tool only searches the usual install locations. When the Host found the
  // shell somewhere else (a portable or custom install), it must say where.
  if (typeof resources === 'string' && resources !== '') parts.push('--resources', quote(resources))
  return parts.join(' ')
}

/**
 * Locate the patch tool inside this package, so the reported command points at
 * a file that actually exists on the user's disk.
 *
 * @returns {string | undefined}
 */
function findPatchScript() {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidate = join(here, 'tools', 'shell-patch', 'patch-asar.cjs')
  return existsSync(candidate) ? candidate : undefined
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
    report.patchSite = main.includes(PATCH_SITE_MARK) || main.includes(PATCH_MARK)
    if (report.patched !== true && report.patchSite === false) {
      report.detail = '补丁点不存在：当前桌面壳版本的分区写法与补丁预期不一致，需要更新补丁'
    } else if (report.patched !== true && report.cachePatch !== true) {
      report.detail = '尚未打补丁'
    }
  } catch (error) {
    report.detail = '解析 app.asar 失败：' + firstLine(error)
  }
  // The user needs a Node binary to run the patch tool. The desktop app ships
  // its own runtime, so nobody has to install one — report the exact command
  // instead of telling them to install Node first.
  report.patchScript = findPatchScript()
  report.nodeBinary = findNodeBinary()
  report.patchCommand =
    report.nodeBinary === undefined ? undefined : patchCommand(report.nodeBinary, report.patchScript, resolved)
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
 * Register the patch checker as an agent tool, so the model can answer
 * "why does my login not survive a restart?" by looking instead of asking the
 * user to run a command and paste its output.
 *
 * The tool is read-only and needs no approval: it reports paths, byte counts
 * and whether the patch marks are present, which the user could read off the
 * disk themselves.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {(() => void) | undefined} a disposer, or undefined without a tool registry
 */
function installTool(ctx) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return undefined
  const definition = {
    name: 'dsh_chat_embed_patch_check',
    description:
      'Report whether the DSH desktop shell has the optional patch that keeps embedded chat logins across restarts: the install directory, whether app.asar is writable, whether it is already patched, whether the patch can still be applied to this shell version, and whether a backup exists. Read-only.',
    parameters: {
      resources: {
        type: 'string',
        description:
          'Optional install directory that contains app.asar. Omit to let the plugin detect the running shell.',
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const requested = args !== undefined && args !== null && typeof args.resources === 'string' ? args.resources : undefined
      return inspectShell(requested)
    },
  }
  try {
    const dispose = tools.register(definition)
    return typeof dispose === 'function' ? dispose : () => {}
  } catch (error) {
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
  ctx.effect(() => installTool(ctx), 'dsh-chat-embed: shell patch tool')
}

/** Exposed for tests and for the patch checker to reuse without a Context. */
export const internals = {
  inspectShell,
  detectResources,
  readAsarEntry,
  readRealFile,
  resourcesCandidates,
  findNodeBinary,
  findPatchScript,
  patchCommand,
  PROBE_PATH,
}
