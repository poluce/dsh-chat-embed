#!/usr/bin/env node
/**
 * verify-bundle.mjs — the repository gate for this plugin package.
 *
 * The package ships no bundler and no build step: `client.js` is hand-written
 * and is the artifact the browser loads. That makes two classes of mistake
 * cheap to introduce and expensive to notice, so this script fails the build
 * on both:
 *
 *   1. a manifest that no longer matches the files (or the loader contract),
 *   2. a display defect the Plugin Manager would render as a fallback.
 *
 * Run it through `npm run check` (which also runs the test suite), or directly
 * with `node scripts/verify-bundle.mjs`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const checked = []

/** @param {string} message */
function fail(message) {
  failures.push(message)
}

/** @param {string} message */
function ok(message) {
  checked.push(message)
}

/** @param {string} name */
function readJson(name) {
  const path = join(root, name)
  if (!existsSync(path)) {
    fail(`${name}: missing`)
    return undefined
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`${name}: not valid JSON (${error.message})`)
    return undefined
  }
}

/** @param {string} name */
function readText(name) {
  const path = join(root, name)
  if (!existsSync(path)) {
    fail(`${name}: missing`)
    return undefined
  }
  return readFileSync(path, 'utf8')
}

// ---------------------------------------------------------------------------
// 1. Syntax gate
// ---------------------------------------------------------------------------

for (const file of ['index.js', 'client.js', 'scripts/verify-bundle.mjs']) {
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { encoding: 'utf8' })
  if (result.status !== 0) {
    fail(`${file}: syntax error\n${(result.stderr || '').trim()}`)
  } else {
    ok(`${file} parses`)
  }
}

// ---------------------------------------------------------------------------
// 2. Manifest
// ---------------------------------------------------------------------------

const pkg = readJson('package.json')
if (pkg !== undefined) {
  const name = pkg.name
  if (typeof name !== 'string' || name === '') fail('package.json: name is required')

  if (pkg.dsh === undefined || pkg.dsh === null) {
    fail('package.json: missing "dsh" section (the loader reads dsh.bundle and dsh.client)')
  } else {
    const bundle = pkg.dsh.bundle
    if (bundle === undefined || typeof bundle.patch !== 'string') {
      fail('package.json: dsh.bundle.patch is required')
    } else if (!existsSync(join(root, bundle.patch))) {
      fail(`package.json: dsh.bundle.patch points at a missing file (${bundle.patch})`)
    } else {
      ok('dsh.bundle.patch resolves')
    }

    const client = pkg.dsh.client
    if (client === undefined || typeof client !== 'object') {
      fail('package.json: dsh.client is required for a browser half')
    } else {
      if (client.platform !== 'web') fail('package.json: dsh.client.platform must be "web"')
      if (!Array.isArray(client.inject)) fail('package.json: dsh.client.inject must be an array')
      else ok(`dsh.client.inject declares ${client.inject.length} module(s)`)
    }
  }

  const exports = pkg.exports
  if (exports === undefined || exports['./client'] === undefined) {
    fail('package.json: exports["./client"] is required (the loader serves that bundle)')
  }
  if (exports === undefined || exports['./icon'] === undefined) {
    fail('package.json: exports["./icon"] is required (Plugin Manager reads the icon)')
  }
  if (exports === undefined || exports['./locale/*.json'] === undefined) {
    fail('package.json: exports["./locale/*.json"] is required (Plugin Manager reads the display metadata)')
  }

  const files = Array.isArray(pkg.files) ? pkg.files : undefined
  if (files === undefined) {
    fail('package.json: "files" is required, otherwise the packed package drops runtime artefacts')
  } else {
    for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
      if (!files.includes(required)) fail(`package.json: "files" must list ${required}`)
    }
    const hasDocs = files.some((entry) => entry === 'docs' || entry.startsWith('docs/'))
    if (!hasDocs) fail('package.json: "files" must list docs')
    for (const required of ['README.md', 'LICENSE']) {
      if (!files.includes(required)) fail(`package.json: "files" must list ${required}`)
    }
    if (failures.length === 0) ok(`"files" lists ${files.length} entries`)
  }
}

// ---------------------------------------------------------------------------
// 3. Loader contract of the client bundle
// ---------------------------------------------------------------------------

const clientSource = readText('client.js')
if (clientSource !== undefined) {
  if (!/^\s*window\.__ModuleLoader__\.load\(\{/m.test(clientSource)) {
    fail('client.js: must start with window.__ModuleLoader__.load({ ... })')
  }
  const idMatch = clientSource.match(/^\s*id:\s*['"]([^'"]+)['"]/m)
  if (idMatch === null) {
    fail('client.js: the loader call must pass an explicit id')
  } else if (pkg !== undefined && idMatch[1] !== pkg.name) {
    fail(`client.js: loader id "${idMatch[1]}" must equal the package name "${pkg.name}"`)
  }
  if (!/factory\s*\(\s*require\s*\)/.test(clientSource) && !/factory\s*:\s*\(\s*require\s*\)/.test(clientSource)) {
    fail('client.js: the loader call must pass factory(require)')
  }
  if (!/require\(\s*['"]react['"]\s*\)/.test(clientSource)) {
    fail("client.js: must require('react') from the shared module table")
  }
  if (!/sidebar\.panellist/.test(clientSource)) fail('client.js: expected a sidebar.panellist registration')
  if (!/name:\s*['"]main['"]/.test(clientSource)) fail('client.js: expected a main-panel registration')
  // Plan B: the chat surface is a child of the panel's layout box, so CSS owns
  // its size and a splitter drag needs no measurement at all.
  if (!/dce-panel dce-inline/.test(clientSource)) {
    fail('client.js: expected the inline surface container (dce-panel dce-inline)')
  }
  if (!/function ChatCenterPage\b/.test(clientSource)) {
    fail('client.js: expected the center-panel page (ChatCenterPage) for the left navigation entry')
  }
  // The resize work must stay event-driven: no timers polling geometry.
  if (/setInterval\s*\(/.test(clientSource)) {
    fail('client.js: setInterval found — the geometry path must stay event-driven')
  }
  // The optional shell patch is what makes cross-restart login possible, so the
  // package must ship the tool and the panel must keep offering the check. A
  // build that drops either leaves users with a state row they cannot act on.
  const hostSource = readText('index.js')
  if (hostSource !== undefined) {
    if (!/export function apply\b/.test(hostSource)) {
      fail('index.js: must export apply() for the loader row')
    }
    if (!/inspectShell/.test(hostSource)) {
      fail('index.js: the shell patch probe (inspectShell) is missing')
    }
    if (!/readAsarEntry/.test(hostSource)) {
      fail('index.js: the probe must read app.asar itself (readAsarEntry)')
    }
  }
  if (!existsSync(join(root, 'tools/shell-patch/patch-asar.cjs'))) {
    fail('tools/shell-patch/patch-asar.cjs: the patch tool must ship with the package')
  }
  if (!/persistRisk/.test(clientSource) || !/patchInstructions/.test(clientSource)) {
    fail('client.js: the panel must keep the experimental notice and the patch instructions')
  }
  // Every service must be https and carry its own storage identity.
  const providerBlock = clientSource.match(/const PROVIDERS = Object\.freeze\(\[([\s\S]*?)\]\.map/)
  if (providerBlock === null) {
    fail('client.js: the PROVIDERS registry is missing')
  } else {
    const body = providerBlock[1]
    const urls = body.match(/url:\s*'([^']+)'/g) || []
    const workspaces = body.match(/workspace:\s*'([^']+)'/g) || []
    if (urls.length < 2) fail('client.js: PROVIDERS needs at least two services')
    if (urls.some((entry) => !/url:\s*'https:\/\//.test(entry))) fail('client.js: every provider url must be https')
    if (workspaces.length !== urls.length) fail('client.js: every provider needs its own workspace identity')
    if (new Set(workspaces).size !== workspaces.length) fail('client.js: provider workspaces must be unique')

    // Runtime code may only talk to declared providers; anything else means a
    // stray endpoint slipped into the bundle.
    const declared = new Set()
    for (const match of body.matchAll(/https:\/\/[a-z0-9.-]+/gi)) declared.add(match[0].toLowerCase())
    const code = clientSource.replace(/^\s*\*.*$/gm, '')
    const stray = []
    for (const match of code.matchAll(/https:\/\/[a-z0-9.-]+/gi)) {
      const origin = match[0].toLowerCase()
      if (!declared.has(origin)) stray.push(origin)
    }
    if (stray.length > 0) fail(`client.js: undeclared external origin(s): ${[...new Set(stray)].join(', ')}`)
    if (failures.length === 0) ok(`${urls.length} chat services registered`)
  }
  if (failures.length === 0) ok('client bundle contract holds')
}

// ---------------------------------------------------------------------------
// 4. Composition patch
// ---------------------------------------------------------------------------

const patch = readText('cordis.patch.yml')
if (patch !== undefined) {
  if (!/^\s*-\s*insert:/m.test(patch)) fail('cordis.patch.yml: expected a top-level "- insert:" entry')
  if (pkg !== undefined) {
    const namePattern = new RegExp(`name:\\s*['"]?${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`, 'm')
    if (!namePattern.test(patch)) fail(`cordis.patch.yml: no row is named after the package (${pkg.name})`)
    else ok('composition patch inserts this package')
  }
}

// ---------------------------------------------------------------------------
// 5. Display resources
// ---------------------------------------------------------------------------

const locales = ['en', 'zh']
const titles = new Map()
for (const id of locales) {
  const dict = readJson(`locale/${id}.json`)
  if (dict === undefined) continue
  const meta = dict.meta
  if (meta === undefined || typeof meta !== 'object') {
    fail(`locale/${id}.json: missing "meta"`)
    continue
  }
  if (typeof meta.title !== 'string' || meta.title.trim() === '') {
    fail(`locale/${id}.json: meta.title is required`)
  } else {
    titles.set(id, meta.title)
  }
  if (typeof meta.description !== 'string' || meta.description.trim() === '') {
    fail(`locale/${id}.json: meta.description is required`)
  }
}
if (titles.size === locales.length && titles.get('en') === titles.get('zh')) {
  fail('locale: the English and Chinese titles are identical — the translation is missing')
}
if (titles.size === locales.length) ok('display metadata covers en and zh')

const iconPath = join(root, 'icon.svg')
if (!existsSync(iconPath)) {
  fail('icon.svg: missing')
} else {
  const size = statSync(iconPath).size
  const icon = readFileSync(iconPath, 'utf8')
  if (size > 256 * 1024) fail(`icon.svg: ${size} bytes exceeds the 256 KiB limit`)
  if (!/<svg[\s>]/.test(icon)) fail('icon.svg: not an SVG document')
  // The XML namespace URI is not a network reference; every other URL is.
  const withoutNamespaces = icon.replace(/\sxmlns(:[A-Za-z0-9-]+)?="[^"]*"/g, '')
  if (/https?:\/\//.test(withoutNamespaces)) fail('icon.svg: must not reference remote resources')
  if (size <= 256 * 1024 && /<svg[\s>]/.test(icon)) ok(`icon.svg renders ${size} bytes`)
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n✗ dsh-chat-embed gate failed (${failures.length}):\n`)
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error('')
  process.exit(1)
}

console.log(`✓ dsh-chat-embed gate passed (${checked.length} checks, root: ${relative(process.cwd(), root) || '.'})`)
