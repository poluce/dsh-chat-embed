/**
 * patch-asar.cjs - two idempotent patches for the desktop shell's embedded
 * browser partitions (resources/app.asar -> lib/main.js).
 *
 * Patch 1 (persistent login): the shell names each workspace's partition
 *   `dsh-sidebar-browser-<random uuid>` - no `persist:` prefix (memory only) and
 *   a fresh uuid every launch, so every embedded webview is signed out on
 *   restart. Hashing the workspace identity instead makes it stable on disk.
 *
 * Patch 2 (no disk cache, optional): the same partition is created with
 *   `{ cache: false }`, so Chromium keeps Cookies / Local Storage / IndexedDB
 *   (the login) but stops writing the multi-megabyte HTTP and code caches.
 *
 * Both steps are idempotent: run build against the original asar or against an
 * already patched one and the result is the same file.
 *
 * Usage:
 *   node patch-asar.cjs build [--from <asar>] [--out <asar>] [--no-cache-patch]
 *   node patch-asar.cjs verify [--from <asar>] [--out <asar>]
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

/**
 * Install locations tried in order when neither --resources nor DSH_RESOURCES
 * is given, so the tool works without an edit on any machine.
 */
const RESOURCES_CANDIDATES = [
  process.env.DSH_RESOURCES,
  process.env.LOCALAPPDATA === undefined || process.env.LOCALAPPDATA === ''
    ? undefined
    : path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources'),
  'C:\\Program Files\\DeepSeek Harness\\resources',
  'C:\\Program Files (x86)\\DeepSeek Harness\\resources',
]

const LOG = path.join(os.tmpdir(), 'dsh-chat-embed-patch-asar.log')

/** @returns {string | undefined} the resources directory that holds app.asar */
function detectResources() {
  for (const candidate of RESOURCES_CANDIDATES) {
    if (typeof candidate !== 'string' || candidate === '') continue
    if (fs.existsSync(path.join(candidate, 'app.asar'))) return candidate
  }
  return undefined
}

const PERSIST_OLD = 'partition = `dsh-sidebar-browser-${randomUUID()}`;'
const PERSIST_NEW =
  'partition = `persist:dsh-sidebar-${createHash("sha256").update(workspace).digest("hex").slice(0, 24)}`;'
const CACHE_OLD = 'this.configureSession(session.fromPartition(partition));'
const CACHE_NEW = 'this.configureSession(session.fromPartition(partition, { cache: false }));'

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`
  console.log(line)
  try {
    fs.appendFileSync(LOG, line + '\n')
  } catch (error) {
    void error
  }
}

/**
 * @param {string[]} argv
 * @returns {{ mode: string, from?: string, out?: string, cachePatch: boolean, help: boolean }}
 */
function parseArgs(argv) {
  const options = { mode: 'build', from: undefined, out: undefined, cachePatch: true, help: false }
  const rest = argv.slice(2)
  let resources
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === 'build' || arg === 'verify') options.mode = arg
    else if (arg === '--resources') resources = rest[++i]
    else if (arg === '--from') options.from = rest[++i]
    else if (arg === '--out') options.out = rest[++i]
    else if (arg === '--no-cache-patch') options.cachePatch = false
    else if (arg === '--help' || arg === '-h') options.help = true
    else {
      console.error('unknown argument: ' + arg)
      options.help = true
    }
  }
  const resolved = resources === undefined ? detectResources() : resources
  if (options.from === undefined && resolved !== undefined) options.from = path.join(resolved, 'app.asar')
  if (options.out === undefined) {
    options.out = resolved !== undefined ? path.join(resolved, 'app.asar.new') : undefined
  }
  return options
}

function usage() {
  console.log(
    [
      'patch-asar.cjs — persistent partitions + no disk cache for the embedded browser',
      '',
      'Usage:',
      '  node patch-asar.cjs build  [--resources <dir>] [--from <asar>] [--out <asar>] [--no-cache-patch]',
      '  node patch-asar.cjs verify [--resources <dir>] [--from <asar>] [--out <asar>]',
      '',
      '--resources  the install directory that contains app.asar (default: $DSH_RESOURCES,',
      '             then %LOCALAPPDATA%\\Programs\\DeepSeek Harness\\resources, then Program Files)',
      '',
      'build writes <resources>/app.asar.new; replace app.asar with it while the app is closed.',
    ].join('\n'),
  )
}

function readAsar(file) {
  const buf = fs.readFileSync(file)
  const jsonLen = buf.readUInt32LE(12)
  const headerStart = 16
  const header = JSON.parse(buf.toString('utf8', headerStart, headerStart + jsonLen))
  const pad = (4 - (jsonLen % 4)) % 4
  const dataStart = headerStart + jsonLen + pad
  return { buf, header, dataStart, data: buf.subarray(dataStart) }
}

function collect(header) {
  const files = []
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files || {})) {
      const p = prefix === '' ? name : prefix + '/' + name
      if (child.files !== undefined) {
        walk(child, p)
        continue
      }
      files.push({ path: p, node: child })
    }
  }
  walk(header, '')
  return files
}

function integrityFor(content) {
  const blockSize = 4194304
  const blocks = []
  for (let offset = 0; offset < content.length; offset += blockSize) {
    blocks.push(
      crypto
        .createHash('sha256')
        .update(content.subarray(offset, Math.min(offset + blockSize, content.length)))
        .digest('hex'),
    )
  }
  if (blocks.length === 0) blocks.push(crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'))
  return {
    algorithm: 'SHA256',
    hash: crypto.createHash('sha256').update(content).digest('hex'),
    blockSize,
    blocks,
  }
}

function applyPatches(source, cachePatch) {
  let text = source
  const applied = []
  if (text.includes(PERSIST_OLD)) {
    text = text.replace(PERSIST_OLD, PERSIST_NEW)
    applied.push('persist-partition')
  }
  if (cachePatch && text.includes(CACHE_OLD)) {
    text = text.replace(CACHE_OLD, CACHE_NEW)
    applied.push('no-disk-cache')
  }
  const ok = text.includes(PERSIST_NEW) && (cachePatch === false || text.includes(CACHE_NEW))
  return { text, applied, ok }
}

function build(options) {
  const { header, data } = readAsar(options.from)
  const files = collect(header)
  log(`source: ${options.from} (${files.length} entries, data ${data.length} bytes)`)

  const packed = files
    .filter((file) => file.node.unpacked !== true)
    .sort((a, b) => Number(a.node.offset) - Number(b.node.offset))

  const chunks = []
  let cursor = 0
  let patched = false

  for (const file of packed) {
    const offset = Number(file.node.offset)
    const size = Number(file.node.size)
    let content = data.subarray(offset, offset + size)

    if (file.path === 'lib/main.js') {
      const source = content.toString('utf8')
      const result = applyPatches(source, options.cachePatch)
      if (!result.ok) throw new Error('lib/main.js does not contain the expected patch sites')
      content = Buffer.from(result.text, 'utf8')
      file.node.size = content.length
      file.node.integrity = integrityFor(content)
      patched = true
      log(`lib/main.js: applied [${result.applied.join(', ') || 'nothing (already patched)'}], ${content.length} bytes`)
    }

    file.node.offset = String(cursor)
    chunks.push(content)
    cursor += content.length
  }

  if (!patched) throw new Error('lib/main.js not found')

  const newData = Buffer.concat(chunks)
  const headerJson = JSON.stringify(header)
  const headerBuf = Buffer.from(headerJson, 'utf8')
  const pad = (4 - (headerBuf.length % 4)) % 4
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(headerBuf.length + 8, 4)
  prefix.writeUInt32LE(headerBuf.length + 4, 8)
  prefix.writeUInt32LE(headerBuf.length, 12)

  const out = Buffer.concat([prefix, headerBuf, Buffer.alloc(pad), newData])
  fs.writeFileSync(options.out, out)
  log(`wrote ${options.out} (${out.length} bytes)`)
  verify(options)
}

function verify(options) {
  if (!fs.existsSync(options.out)) throw new Error(options.out + ' is missing')
  const base = readAsar(options.from)
  const built = readAsar(options.out)
  const baseFiles = collect(base.header)
  const builtFiles = collect(built.header)

  if (baseFiles.length !== builtFiles.length) {
    throw new Error(`entry count changed: ${baseFiles.length} -> ${builtFiles.length}`)
  }

  const baseByPath = new Map(baseFiles.map((file) => [file.path, file]))
  let compared = 0
  let patchedSeen = false

  for (const file of builtFiles) {
    const before = baseByPath.get(file.path)
    if (before === undefined) throw new Error(`new entry appeared: ${file.path}`)
    if (file.node.unpacked === true || before.node.unpacked === true) {
      if (Number(file.node.size) !== Number(before.node.size)) throw new Error(`size drift on unpacked ${file.path}`)
      continue
    }
    const builtBytes = built.data.subarray(Number(file.node.offset), Number(file.node.offset) + Number(file.node.size))
    if (file.path === 'lib/main.js') {
      const text = builtBytes.toString('utf8')
      if (!text.includes(PERSIST_NEW)) throw new Error('persist patch missing in rebuilt asar')
      if (options.cachePatch !== false && !text.includes(CACHE_NEW)) throw new Error('cache patch missing in rebuilt asar')
      patchedSeen = true
      continue
    }
    const beforeBytes = base.data.subarray(Number(before.node.offset), Number(before.node.offset) + Number(before.node.size))
    if (!builtBytes.equals(beforeBytes)) throw new Error(`content drift: ${file.path}`)
    compared += 1
  }

  if (!patchedSeen) throw new Error('patched file not found during verification')
  log(`verified: ${compared} files byte-identical, lib/main.js patched, ${builtFiles.length} entries total`)
}

const options = parseArgs(process.argv)
if (options.help === true || options.from === undefined || options.out === undefined) {
  usage()
  process.exit(options.help === true ? 0 : 1)
}
if (options.mode === 'build') build(options)
else verify(options)
log('done: ' + options.mode)
