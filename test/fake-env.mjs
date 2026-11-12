/**
 * A minimal DOM + desktop-shell double for the Client half.
 *
 * The bundle is a classic script, not a module, so the suite imports it once
 * with `window.__ModuleLoader__` in place, then asks the captured factory for a
 * fresh plugin instance per test. Every instance owns its own closure, which
 * keeps the guest and status state isolated without re-importing the file.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CLIENT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

/** @returns {string} the package name the bundle must register. */
export function packageName() {
  const manifest = JSON.parse(readFileSync(join(dirname(CLIENT_PATH), 'package.json'), 'utf8'))
  return manifest.name
}

/** @param {string} tagName */
export class FakeNode {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase()
    this.children = []
    /** @type {Map<string, string>} */
    this.attributes = new Map()
    /** @type {Map<string, Function[]>} */
    this.listeners = new Map()
    /** @type {FakeNode | null} */
    this.parentNode = null
    /** @type {FakeNode | null} */
    this.parentElement = null
    this.isConnected = false
    this.style = { cssText: '' }
    this.className = ''
    this.id = ''
    /** @type {{ left: number, top: number, width: number, height: number }} */
    this.rect = { left: 0, top: 0, width: 0, height: 0 }
    /** @type {string} */ this._text = ''
  }

  getBoundingClientRect() {
    return this.rect
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value))
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  hasAttribute(name) {
    return this.attributes.has(name)
  }

  removeAttribute(name) {
    this.attributes.delete(name)
  }

  set textContent(value) {
    this._text = String(value)
    this.children = []
  }

  get textContent() {
    return this._text
  }

  appendChild(child) {
    if (child.parentNode !== null && child.parentNode !== undefined) child.parentNode.removeChild(child)
    this.children.push(child)
    child.parentNode = this
    child.parentElement = this
    child.setConnected(this.isConnected)
    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    child.parentElement = null
    child.setConnected(false)
    return child
  }

  remove() {
    if (this.parentNode !== null && this.parentNode !== undefined) this.parentNode.removeChild(this)
  }

  setConnected(value) {
    this.isConnected = value
    for (const child of this.children) child.setConnected(value)
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type)
    if (list === undefined) this.listeners.set(type, [listener])
    else list.push(listener)
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type)
    if (list === undefined) return
    const index = list.indexOf(listener)
    if (index >= 0) list.splice(index, 1)
  }

  /** Deliver one event to every listener, like a DOM dispatch. */
  fire(type, extra = {}) {
    const list = this.listeners.get(type)
    if (list === undefined) return
    for (const listener of [...list]) listener({ type, target: this, currentTarget: this, ...extra })
  }

  *walk() {
    yield this
    for (const child of this.children) yield* child.walk()
  }
}

/**
 * @param {{ webview?: { autoNavigate?: boolean, landingUrl?: string } }} [options]
 */
export function createFakeDocument(options = {}) {
  const webviewOptions = options.webview === undefined ? {} : options.webview
  const body = new FakeNode('body')
  body.setConnected(true)
  const head = new FakeNode('head')
  head.setConnected(true)

  const document = {
    body,
    head,
    createElement(tagName) {
      const node = new FakeNode(tagName)
      if (node.tagName === 'WEBVIEW') {
        node.url = ''
        node.executed = []
        node.getURL = () => node.url
        node.executeJavaScript = (code) => {
          node.executed.push(code)
          if (webviewOptions.autoNavigate !== false) {
            node.url = webviewOptions.landingUrl === undefined ? 'https://landing.test/' : webviewOptions.landingUrl
          }
          return Promise.resolve(true)
        }
      }
      return node
    },
    getElementById(id) {
      for (const node of body.walk()) if (node.id === id) return node
      for (const node of head.walk()) if (node.id === id) return node
      return null
    },
    querySelector(selector) {
      const match = /^\[([^\]=]+)="([^"]*)"\]$/.exec(selector)
      if (match === null) return null
      for (const node of body.walk()) if (node.getAttribute(match[1]) === match[2]) return node
      return null
    },
  }
  return document
}

/**
 * A stand-in for `window.dshDesktop.browser`: unique leases per call, plus the
 * per-lease popup channel the shell uses to relay `window.open` requests.
 *
 * @param {{ acquire?: Function, release?: Function }} [options]
 */
export function createFakeShell(options = {}) {
  const calls = { acquire: [], release: [], openRequested: [] }
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map()
  let issued = 0
  const bridge = {
    async acquire(workspace) {
      calls.acquire.push(workspace)
      if (typeof options.acquire === 'function') return options.acquire(workspace, calls)
      issued += 1
      return { lease: `lease-${issued}`, partition: `partition-${issued}` }
    },
    async release(lease) {
      calls.release.push(lease)
      if (typeof options.release === 'function') return options.release(lease, calls)
      return undefined
    },
    onOpenRequested(lease, listener) {
      calls.openRequested.push(lease)
      let set = listeners.get(lease)
      if (set === undefined) {
        set = new Set()
        listeners.set(lease, set)
      }
      set.add(listener)
      return () => {
        const current = listeners.get(lease)
        if (current === undefined) return
        current.delete(listener)
        if (current.size === 0) listeners.delete(lease)
      }
    },
  }
  return {
    bridge,
    calls,
    /** Deliver a relayed popup request, like the shell's bridge does. */
    emitOpenRequested(lease, url) {
      for (const listener of [...(listeners.get(lease) || [])]) listener(url)
    },
    /** @param {string} lease */
    listenerCount(lease) {
      const set = listeners.get(lease)
      return set === undefined ? 0 : set.size
    },
  }
}

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) dsh-desktop/0.2.2-rc.1 Chrome/152.0.0.0 Electron/44.7.0 Safari/537.36'

/** In-memory stand-in for the page's localStorage. */
export class FakeStorage {
  constructor() {
    /** @type {Map<string, string>} */
    this.map = new Map()
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null
  }

  setItem(key, value) {
    this.map.set(key, String(value))
  }

  removeItem(key) {
    this.map.delete(key)
  }

  clear() {
    this.map.clear()
  }
}

/** React double: enough surface for the factory to build its plugin record. */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props === undefined ? {} : props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (initial) => ({ current: initial }),
}

/**
 * Node exposes `navigator` as a getter-only accessor, so browser globals are
 * installed through defineProperty instead of assignment.
 *
 * @param {string} name
 * @param {any} value
 */
function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true })
}

/** @param {string} name */
function deleteGlobal(name) {
  try {
    delete globalThis[name]
  } catch (error) {
    void error
    defineGlobal(name, undefined)
  }
}

/** @param {string} specifier */
function fakeRequire(specifier) {
  if (specifier === 'react') return fakeReact
  throw new Error(`unexpected require("${specifier}") from the client bundle`)
}

/** @type {Promise<any> | undefined} */
let bundleOptionsPromise

/** Import the classic script once and return the captured loader options. */
function ensureBundleLoaded() {
  if (bundleOptionsPromise !== undefined) return bundleOptionsPromise
  bundleOptionsPromise = (async () => {
    /** @type {{ options?: any }} */
    const captured = {}
    defineGlobal('window', {
      __ModuleLoader__: {
        load(options) {
          captured.options = options
        },
      },
      open() {},
    })
    defineGlobal('document', createFakeDocument())
    defineGlobal('navigator', { userAgent: DEFAULT_USER_AGENT })
    await import(pathToFileURL(CLIENT_PATH).href)
    if (captured.options === undefined) throw new Error('client.js did not call window.__ModuleLoader__.load')
    return captured.options
  })()
  return bundleOptionsPromise
}

/**
 * Build one fresh plugin instance and install its globals.
 *
 * @param {{ shell?: ReturnType<typeof createFakeShell>, document?: any, userAgent?: string, storage?: FakeStorage }} [environment]
 */
export async function createInstance(environment = {}) {
  const options = await ensureBundleLoaded()
  const document = environment.document === undefined ? createFakeDocument() : environment.document
  const shell = environment.shell
  const storage = environment.storage === undefined ? new FakeStorage() : environment.storage
  const window = {
    __ModuleLoader__: options.loader,
    open(...args) {
      window.opened = args
    },
  }
  if (shell !== undefined) window.dshDesktop = { browser: shell.bridge }

  defineGlobal('window', window)
  defineGlobal('document', document)
  defineGlobal('localStorage', storage)
  defineGlobal('navigator', {
    userAgent: environment.userAgent === undefined ? DEFAULT_USER_AGENT : environment.userAgent,
  })
  globalThis.__DSH_CHAT_EMBED_TEST__ = true

  const plugin = options.factory(fakeRequire)
  const internals = globalThis.__DSHCE_TEST__
  if (internals === undefined) throw new Error('client.js did not publish its test hook')
  return { bundle: options, plugin, internals, document, window, shell, storage }
}

/** Remove the globals so a failure cannot leak into the next test. */
export function resetEnvironment() {
  deleteGlobal('window')
  deleteGlobal('document')
  deleteGlobal('localStorage')
  deleteGlobal('navigator')
  deleteGlobal('__DSH_CHAT_EMBED_TEST__')
  deleteGlobal('__DSHCE_TEST__')
}

/**
 * Poll until `predicate` holds.
 *
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 */
export async function waitFor(predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for a condition')
}
