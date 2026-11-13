/**
 * Contract tests for the Client half.
 *
 * Three things can only break at runtime: the slot registrations, the desktop
 * shell's lease handshake, and the multi-tab lifecycle (one guest per service,
 * each kept alive across tab *and* panel switches).
 *
 * Everything runs against doubles (`test/fake-env.mjs`), so the suite is
 * offline and deterministic.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test, { afterEach } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_USER_AGENT,
  FakeStorage,
  createFakeDocument,
  createFakeShell,
  createInstance,
  packageName,
  resetEnvironment,
  waitFor,
} from './fake-env.mjs'

const here = dirname(fileURLToPath(import.meta.url))

afterEach(() => {
  resetEnvironment()
})

/** A Cordis-like Client context that records slot traffic. */
function createFakeCtx(options = {}) {
  const rejectSlots = options.rejectSlots === undefined ? [] : options.rejectSlots
  const hasRightSidebar = options.rightSidebar !== false
  /** @type {string[]} */
  const injected = []
  /** @type {{ options: any, component: any }[]} */
  const registrations = []
  /** @type {string[][]} */
  const injectedServices = []
  /** @type {any[]} */
  const tabTypes = []
  /** @type {string[]} */
  const openedTabs = []
  let dicts = {}
  let activeLocale = 'zh'
  /** @type {Record<string, ((...args: any[]) => void)[]>} */
  const eventHandlers = {}

  /** Right-sidebar doubles: present unless a test removes them. */
  const sidebarRightTabs = {
    register(definition) {
      tabTypes.push(definition)
      return () => {}
    },
  }
  const sidebarRight = {
    openTab(kind) {
      openedTabs.push(kind)
    },
  }
  /** Client inspect registry double. */
  const inspectProviders = []
  const cordisInspect = {
    register(registration) {
      inspectProviders.push(registration)
      return () => {
        const index = inspectProviders.indexOf(registration)
        if (index !== -1) inspectProviders.splice(index, 1)
      }
    },
  }

  const ctx = {
    on(event, handler) {
      if (eventHandlers[event] === undefined) eventHandlers[event] = []
      eventHandlers[event].push(handler)
      return () => {
        const list = eventHandlers[event]
        const index = list.indexOf(handler)
        if (index !== -1) list.splice(index, 1)
      }
    },
    /** Test-only: switch the active locale and fire locale/change like the host. */
    __setLocale(next) {
      activeLocale = next
      for (const handler of [...(eventHandlers['locale/change'] ?? [])]) handler()
    },
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      if (!hasRightSidebar) return undefined
      if (name === 'sidebarRightTabs') return sidebarRightTabs
      if (name === 'sidebarRight') return sidebarRight
      if (name === 'cordisInspect') return cordisInspect
      return undefined
    },
    inject(deps, callback) {
      injectedServices.push(deps)
      const scope = {
        effect: ctx.effect,
        slots: ctx.slots,
        locale: ctx.locale,
        sidebarRightTabs,
        sidebarRight,
      }
      callback(scope)
      return () => {}
    },
    locale: {
      getLocale() {
        return { active: activeLocale, locales: [{ id: 'en' }, { id: 'zh' }], revision: 1 }
      },
      register(_ns, dictionaries) {
        dicts = dictionaries
        return () => {}
      },
      bind() {
        return (key, params) => {
          const active = dicts[activeLocale] === undefined ? {} : dicts[activeLocale]
          const other = activeLocale === 'zh' ? dicts.en : dicts.zh
          const template = active[key] !== undefined ? active[key] : other === undefined || other[key] === undefined ? key : other[key]
          if (params === undefined) return template
          return String(template).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
        }
      },
    },
    slots: {
      inject(name, callback) {
        if (rejectSlots.includes(name)) throw new Error('slot is not available: ' + name)
        injected.push(name)
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }

  return { ctx, injected, injectedServices, registrations, tabTypes, openedTabs, inspectProviders }
}

/** Wire the React-owned parts the way the app does: a host div inside the seat. */
function attachSurface(instance) {
  const document = instance.document
  const host = document.createElement('div')
  document.body.appendChild(host)
  instance.internals.updateSurface({ host })
  return { host }
}

/** @param {any} instance @param {string} id */
function guestOf(instance, id) {
  return instance.internals.guestRecord(id)
}

/** Open a tab and wait for its guest element to exist. */
async function openTab(instance, id) {
  await instance.internals.setActive(id)
  return guestOf(instance, id)
}

test('the bundle registers exactly one factory under the package name', async () => {
  const { bundle } = await createInstance()
  assert.equal(bundle.id, packageName())
  assert.equal(typeof bundle.factory, 'function')
})

test('the plugin record injects the client services it consumes', async () => {
  const { plugin } = await createInstance()
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers the center page, the navigation icon and the inline right tab', async () => {
  const { plugin, internals } = await createInstance()
  const harness = createFakeCtx()

  plugin.apply(harness.ctx)

  assert.deepEqual(harness.injected, [
    'main',
    'sidebar.panellist',
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
    'conversation.session.header.utilities',
  ])

  const surface = harness.registrations.find((entry) => entry.options.name === 'main')
  assert.ok(surface, 'the center page registration is missing')
  assert.equal(surface.options.key, internals.PANEL_ID)
  assert.equal(surface.component, internals.ChatCenterPage)

  const main = harness.registrations.find((entry) => entry.options.name === 'main')
  assert.ok(main, 'the center page is missing')
  assert.equal(main.options.key, internals.PANEL_ID)
  assert.equal(typeof main.component, 'function')

  const nav = harness.registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.ok(nav, 'the navigation entry is missing')
  assert.equal(nav.options.id, internals.PANEL_ID)
  assert.equal(nav.options.order, 30)
  assert.equal(typeof nav.options.label, 'function')
  assert.equal(nav.options.label(), '聊天')
  assert.equal(typeof nav.component, 'function')
})

test('the stylesheet is installed with the plugin', async () => {
  const { plugin } = await createInstance()
  const harness = createFakeCtx()

  plugin.apply(harness.ctx)
  const style = globalThis.document.getElementById('dsh-chat-embed-styles')
  assert.ok(style, 'the plugin should install its stylesheet')
  assert.match(style.textContent, /\.dce-tab\[data-active="true"\]/)
  assert.match(style.textContent, /\.dce-guest-layer\[data-active="true"\]\{display:flex\}/)
  assert.match(style.textContent, /--dsw-alias-bg-base/)
})

test('normalizedUserAgent strips the desktop shell tokens', async () => {
  const { internals } = await createInstance()
  const normalized = internals.normalizedUserAgent(DEFAULT_USER_AGENT)

  assert.ok(!normalized.includes('Electron/'), `Electron token survived: ${normalized}`)
  assert.ok(!normalized.includes('dsh-desktop/'), `app token survived: ${normalized}`)
  assert.match(normalized, /Chrome\/152\.0\.0\.0/)
  assert.match(normalized, /^Mozilla\/5\.0 /)

  assert.equal(internals.normalizedUserAgent(''), '')
  assert.equal(internals.normalizedUserAgent(undefined), '')
})

test('the provider registry is well formed and isolated per service', async () => {
  const { internals } = await createInstance()
  const providers = internals.PROVIDERS

  assert.ok(providers.length >= 4, 'expected several default services')
  assert.equal(providers[0].id, internals.DEFAULT_PROVIDER, 'DeepSeek stays the first tab')

  const ids = new Set()
  const workspaces = new Set()
  for (const provider of providers) {
    assert.match(provider.id, /^[a-z0-9-]+$/, `bad id: ${provider.id}`)
    assert.ok(provider.label.trim() !== '', `missing label for ${provider.id}`)
    assert.match(provider.url, /^https:\/\//, `non-https url for ${provider.id}`)
    assert.ok(provider.url.startsWith(provider.origin), `origin must prefix url for ${provider.id}`)
    assert.ok(!ids.has(provider.id), `duplicate id ${provider.id}`)
    assert.ok(!workspaces.has(provider.workspace), `duplicate workspace for ${provider.id}`)
    // Each provider owns a storage identity; DeepSeek keeps its original key so
    // an existing session is not signed out by the multi-tab upgrade.
    assert.ok(
      provider.workspace.startsWith('dsh-chat-embed:'),
      `workspace must live in this plugin's namespace: ${provider.id}`,
    )
    ids.add(provider.id)
    workspaces.add(provider.workspace)
  }
})

// ---------------------------------------------------------------------------
// Lease handshake, per tab
// ---------------------------------------------------------------------------

test('activating a tab acquires a lease for that provider and attaches its guest', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  attachSurface(instance)

  const record = await openTab(instance, 'doubao')
  const provider = instance.internals.findProvider('doubao')

  assert.deepEqual(shell.calls.acquire, [provider.workspace])
  assert.ok(record.element, 'the guest should exist')
  assert.equal(record.element.getAttribute('src'), 'about:blank#lease-1')
  assert.equal(record.element.getAttribute('partition'), 'partition-1')

  const userAgent = record.element.getAttribute('useragent')
  assert.match(userAgent, /Chrome\/152/)
  assert.ok(!userAgent.includes('Electron/'))

  assert.equal(record.layer.getAttribute('data-active'), 'true')
  assert.equal(instance.internals.getStatus().phase, 'navigating')
  assert.equal(record.mounts, 1)
})

test('each tab navigates to its own service URL', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  attachSurface(instance)

  const deepseek = await openTab(instance, 'deepseek')
  const doubao = await openTab(instance, 'doubao')

  deepseek.element.fire('dom-ready')
  doubao.element.fire('dom-ready')
  await waitFor(
    () => guestOf(instance, 'deepseek').phase === 'ready' && guestOf(instance, 'doubao').phase === 'ready',
  )

  assert.equal(deepseek.element.executed[0], 'location.href = "https://chat.deepseek.com/";')
  assert.equal(doubao.element.executed[0], 'location.href = "https://www.doubao.com/chat/";')
})

test('a navigation in flight is never restarted', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  attachSurface(instance)

  const record = await openTab(instance, 'deepseek')
  // Record the assignment without letting the fake land, so the test controls
  // when the document commits — the way a real network does.
  const issued = []
  record.element.executeJavaScript = (code) => {
    issued.push(code)
    return Promise.resolve(true)
  }
  record.element.fire('dom-ready')

  // The page is now fetching its first byte: getURL() still returns about:blank
  // and the guest reports loading. Reassigning location.href here would cancel
  // the request and start it over, which is what made every mount look like it
  // loaded the page two or three times.
  record.element.loading = true
  await new Promise((resolve) => setTimeout(resolve, 1200))

  assert.equal(issued.length, 1, 'the navigation must be issued once')
  assert.equal(issued[0], 'location.href = "https://chat.deepseek.com/";')
  assert.equal(guestOf(instance, 'deepseek').phase, 'navigating')

  // The document commits and the tab becomes ready.
  record.element.url = 'https://chat.deepseek.com/'
  record.element.loading = false
  await waitFor(() => guestOf(instance, 'deepseek').phase === 'ready', 3000)
  assert.equal(issued.length, 1, 'landing must not trigger another navigation')
})

test('navigation gives up for a tab that never leaves about:blank', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  attachSurface(instance)

  const record = await openTab(instance, 'kimi')
  let attempts = 0
  record.element.executeJavaScript = () => {
    attempts += 1
    return Promise.resolve(true)
  }
  record.element.fire('dom-ready')

  await waitFor(() => instance.internals.getStatus().phase === 'failed', 8000)
  assert.equal(instance.internals.getStatus().detail, 'navigation-timeout')
  assert.equal(attempts, 5, 'every attempt must run')
})

test('a rejected lease surfaces as a failed tab', async () => {
  const shell = createFakeShell({ acquire: () => Promise.reject(new Error('lease denied')) })
  const instance = await createInstance({ shell })
  attachSurface(instance)

  const record = await openTab(instance, 'chatgpt')

  assert.equal(instance.internals.getStatus().phase, 'failed')
  assert.equal(instance.internals.getStatus().detail, 'lease denied')
  assert.equal(record.element, undefined)
})

test('a lease that arrives after teardown is released immediately', async () => {
  /** @type {(value: any) => void} */
  let settle
  const shell = createFakeShell({
    acquire: () =>
      new Promise((resolve) => {
        settle = resolve
      }),
  })
  const instance = await createInstance({ shell })
  attachSurface(instance)

  const opening = instance.internals.setActive('doubao')
  instance.internals.destroyGuests()
  settle({ lease: 'late-lease', partition: 'late-partition' })
  await opening

  assert.deepEqual(shell.calls.release, ['late-lease'])
  assert.equal(guestOf(instance, 'doubao').element, undefined)
})

test('without a desktop bridge every tab degrades to the unsupported phase', async () => {
  const instance = await createInstance()
  attachSurface(instance)

  const record = await openTab(instance, 'deepseek')

  assert.equal(instance.internals.getStatus().phase, 'unsupported')
  assert.equal(record.element, undefined)
})

// ---------------------------------------------------------------------------
// Tab lifecycle: one live guest per service, none re-created on switching
// ---------------------------------------------------------------------------

test('switching tabs keeps every guest alive and never re-acquires', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  attachSurface(instance)

  const deepseek = await openTab(instance, 'deepseek')
  const doubao = await openTab(instance, 'doubao')

  assert.notEqual(deepseek.element, doubao.element)
  assert.equal(deepseek.element.isConnected, true, 'the hidden tab must stay in the document')
  assert.equal(deepseek.layer.getAttribute('data-active'), 'false')
  assert.equal(doubao.layer.getAttribute('data-active'), 'true')

  await instance.internals.setActive('deepseek')

  assert.equal(guestOf(instance, 'deepseek').element, deepseek.element, 'the same element must be reused')
  assert.equal(deepseek.layer.getAttribute('data-active'), 'true')
  assert.equal(doubao.layer.getAttribute('data-active'), 'false')
  assert.equal(shell.calls.acquire.length, 2, 'a live guest needs no second lease')
  assert.equal(shell.calls.release.length, 0)
})

test('a failing tab does not disturb the others', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  attachSurface(instance)

  const deepseek = await openTab(instance, 'deepseek')
  deepseek.element.fire('dom-ready')
  await waitFor(() => guestOf(instance, 'deepseek').phase === 'ready')

  const kimi = await openTab(instance, 'kimi')
  kimi.element.executeJavaScript = () => Promise.resolve(true)
  kimi.element.fire('dom-ready')
  await waitFor(() => guestOf(instance, 'kimi').phase === 'failed', 8000)

  assert.equal(guestOf(instance, 'deepseek').phase, 'ready', 'the good tab keeps its state')
  await instance.internals.setActive('deepseek')
  assert.equal(instance.internals.getStatus().phase, 'ready')
})

test('reloading one tab releases only that tab lease', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  attachSurface(instance)

  const deepseek = await openTab(instance, 'deepseek')
  const doubao = await openTab(instance, 'doubao')
  const deepseekElement = deepseek.element
  const doubaoElement = doubao.element

  await instance.internals.reloadGuest('doubao')

  assert.deepEqual(shell.calls.release, ['lease-2'])
  assert.equal(guestOf(instance, 'deepseek').element, deepseekElement)
  assert.equal(deepseekElement.isConnected, true)
  assert.notEqual(guestOf(instance, 'doubao').element, doubaoElement)
  assert.equal(shell.calls.acquire.length, 3)
})

test('destroying the surface releases every lease', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  attachSurface(instance)

  const deepseek = await openTab(instance, 'deepseek')
  await openTab(instance, 'doubao')
  const deepseekElement = deepseek.element

  instance.internals.destroyGuests()

  assert.deepEqual(shell.calls.release.slice().sort(), ['lease-1', 'lease-2'])
  assert.equal(deepseekElement.isConnected, false)
  assert.equal(guestOf(instance, 'deepseek').element, undefined)
  assert.equal(instance.internals.getStatus().phase, 'idle')
})

test('the active tab is remembered across plugin instances', async () => {
  const storage = new FakeStorage()
  const shell = createFakeShell()

  const first = await createInstance({ shell, storage })
  attachSurface(first)
  await first.internals.setActive('chatgpt')
  assert.equal(storage.getItem(first.internals.ACTIVE_TAB_KEY), 'chatgpt')

  const second = await createInstance({ shell, storage })
  assert.equal(second.internals.activeProvider().id, 'chatgpt')
})

test('the tab order is remembered across plugin instances', async () => {
  const storage = new FakeStorage()
  const shell = createFakeShell()

  const first = await createInstance({ shell, storage })
  first.internals.moveProvider('kimi', 0)
  assert.deepEqual(first.internals.getTabOrder().slice(0, 2), ['kimi', 'deepseek'])
  assert.equal(storage.getItem(first.internals.TAB_ORDER_KEY), JSON.stringify(first.internals.getTabOrder()))

  const second = await createInstance({ shell, storage })
  assert.equal(second.internals.getTabOrder()[0], 'kimi')
  assert.equal(second.internals.orderedProviders()[0].id, 'kimi')
})

test('moveProvider clamps and keeps every provider exactly once', async () => {
  const { internals } = await createInstance()
  const total = internals.PROVIDERS.length

  internals.moveProvider('grok', -5)
  assert.equal(internals.getTabOrder()[0], 'grok')

  internals.moveProvider('grok', 999)
  assert.equal(internals.getTabOrder().at(-1), 'grok')
  assert.equal(internals.getTabOrder().length, total)
  assert.equal(new Set(internals.getTabOrder()).size, total)
})

test('the tab bar auto-hides over the page', async () => {
  const { internals } = await createInstance()
  const css = internals.CSS

  assert.match(css, /\.dce-tabs\{position:absolute/, 'the bar floats above the page')
  assert.match(css, /\.dce-tabs\{[^}]*pointer-events:none/, 'a hidden bar must not swallow clicks')
  assert.match(css, /\.dce-tabs\{[^}]*transform:translateY\(-110%\)/, 'a hidden bar sits outside the panel')
  assert.match(css, /\.dce-tabs\[data-visible="true"\]\{transform:translateY\(0\)/, 'revealing slides it back')
  assert.match(css, /\.dce-hotzone\{position:absolute;top:0/, 'a top hot zone triggers the reveal')
  assert.match(css, /\.dce-surface\{position:absolute;inset:0/, 'the page fills the panel')
})

test('every provider is enabled by default', async () => {
  const { internals } = await createInstance()
  assert.equal(internals.getEnabled().length, internals.PROVIDERS.length)
  assert.equal(internals.orderedProviders().length, internals.PROVIDERS.length)
  assert.equal(internals.isEnabled('grok'), true)
})

test('disabling a provider hides its tab and is remembered', async () => {
  const storage = new FakeStorage()
  const shell = createFakeShell()

  const first = await createInstance({ shell, storage })
  assert.equal(first.internals.setProviderEnabled('grok', false), true)
  assert.equal(first.internals.isEnabled('grok'), false)
  assert.equal(
    first.internals.orderedProviders().some((entry) => entry.id === 'grok'),
    false,
    'a disabled provider must leave the tab bar',
  )
  assert.equal(
    JSON.parse(storage.getItem(first.internals.ENABLED_KEY)).includes('grok'),
    false,
    'the preference is persisted',
  )

  const second = await createInstance({ shell, storage })
  assert.equal(second.internals.isEnabled('grok'), false)
})

test('the last enabled provider cannot be disabled', async () => {
  const { internals } = await createInstance()
  const keep = internals.PROVIDERS[0].id
  for (const provider of internals.PROVIDERS) {
    if (provider.id === keep) continue
    internals.setProviderEnabled(provider.id, false)
  }

  assert.equal(internals.getEnabled().length, 1)
  assert.equal(internals.setProviderEnabled(keep, false), false, 'the last tab is protected')
  assert.equal(internals.isEnabled(keep), true)
  assert.equal(internals.orderedProviders().length, 1)
})

test('disabling the active provider switches tabs and frees its guest', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  attachSurface(instance)

  const record = instance.internals.guestRecord('deepseek')
  instance.internals.setActive('deepseek')
  await waitFor(() => record.element !== undefined)
  const lease = record.lease

  assert.equal(instance.internals.setProviderEnabled('deepseek', false), true)
  assert.notEqual(instance.internals.activeProvider().id, 'deepseek')
  assert.equal(record.element, undefined, 'the hidden guest is torn down')
  assert.ok(shell.calls.release.includes(lease), 'its lease is released')
})

test('re-enabling a provider restores its place in the tab order', async () => {
  const { internals } = await createInstance()
  const before = internals.getTabOrder().indexOf('minimax')

  internals.setProviderEnabled('minimax', false)
  assert.equal(internals.getTabOrder().includes('minimax'), true, 'order keeps disabled ids')
  assert.equal(internals.orderedProviders().some((entry) => entry.id === 'minimax'), false)

  internals.setProviderEnabled('minimax', true)
  assert.equal(internals.getTabOrder().indexOf('minimax'), before)
  assert.equal(internals.orderedProviders().some((entry) => entry.id === 'minimax'), true)
})

test('a stored enabled list drops unknown ids and never empties the bar', async () => {
  const storage = new FakeStorage()
  storage.setItem('dsh-chat-embed:enabled', JSON.stringify(['ghost', 'kimi', 'kimi']))

  const instance = await createInstance({ storage })
  assert.deepEqual(instance.internals.getEnabled(), ['kimi'])

  const empty = new FakeStorage()
  empty.setItem('dsh-chat-embed:enabled', JSON.stringify([]))
  const fallback = await createInstance({ storage: empty })
  assert.equal(fallback.internals.getEnabled().length, fallback.internals.PROVIDERS.length)
})

test('the diagnostics report copies as plain text', async () => {
  const { internals } = await createInstance()
  const labels = {
    diagTitle: 'Tab diagnostics',
    diagUrl: 'URL',
    diagFrame: 'Frame',
    diagPhase: 'State',
    partitionLabel: 'Partition',
    diagEvent: 'Last event',
    diagHandoff: 'Handoff probe',
  }

  const report = internals.formatDiagReport({
    labels,
    url: 'https://grok.com/',
    phase: 'ready',
    detail: '',
    partition: '1b68',
    mounts: 1,
    lastEvent: 'probe:content',
    handoff: '',
    build: internals.BUILD,
  })

  assert.match(report, /^Tab diagnostics\n/)
  assert.match(report, /URL: https:\/\/grok\.com\//)
  assert.match(report, /Partition: 1b68 · #1/)
  assert.match(report, /Last event: probe:content/)
  assert.ok(!report.includes('Handoff probe'), 'an empty handoff line is omitted')
  assert.match(report, new RegExp('dsh-chat-embed ' + internals.BUILD.replace(/\./g, '\\.')))

  const withHandoff = internals.formatDiagReport({ ...{ labels, url: '', frame: undefined, phase: 'idle', detail: '', partition: '—', mounts: 0, lastEvent: '', handoff: '{"hash":0}', build: 'x' } })
  assert.match(withHandoff, /URL: —/, 'an unknown URL is rendered as a dash')
  assert.match(withHandoff, /Handoff probe: \{"hash":0\}/)
})

test('copyText degrades to false without a clipboard or DOM', async () => {
  const { internals } = await createInstance()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true, writable: true })
  try {
    assert.equal(await internals.copyText('hello'), false)
  } finally {
    if (previous === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', previous)
  }
})

test('the diagnostics report carries the right column and the seat boxes', async () => {
  const { internals } = await createInstance()
  const labels = {
    diagTitle: 'Tab diagnostics',
    diagUrl: 'URL',
    diagFrame: 'Frame',
    diagPhase: 'State',
    partitionLabel: 'Partition',
    diagEvent: 'Last event',
    diagHandoff: 'Handoff probe',
    diagRight: 'Right column',
    diagSeat: 'Seat',
  }

  const report = internals.formatDiagReport({
    labels,
    url: 'https://chat.deepseek.com/',
    frame: undefined,
    phase: 'ready',
    detail: '',
    partition: '70ea',
    mounts: 1,
    lastEvent: 'probe:content',
    handoff: '',
    right: 'registered · body=ok,title=ok,dock=ok',
    seat: 'right shown=600,40 400×660 panel=600,0 400×700 sync#3',
    build: internals.BUILD,
  })

  assert.match(report, /Right column: registered · body=ok,title=ok,dock=ok/)
  assert.match(report, /Seat: right shown=600,40 400×660 panel=600,0 400×700 sync#3/)
})

test('the inspect provider exposes the live seat report to the host', async () => {
  const { plugin, internals } = await createInstance()
  const harness = createFakeCtx()

  plugin.apply(harness.ctx)

  assert.equal(harness.inspectProviders.length, 1, 'one read-only provider is registered')
  const registration = harness.inspectProviders[0]
  assert.equal(registration.manifest.id, 'dsh-chat-embed')
  assert.deepEqual(
    registration.manifest.methods.map((method) => method.name),
    ['seatReport', 'openPanel', 'dragProbe', 'handles', 'layout', 'log', 'locale', 'prefer', 'dom', 'openRight'],
  )
  assert.throws(() => registration.query('nope'), /unknown dsh-chat-embed inspect method/)

  const report = registration.query('seatReport')
  assert.equal(report.build, internals.BUILD)
  assert.equal(report.mode, 'inline', 'geometry is owned by CSS now')
  assert.equal(report.seat, 'none', 'no seat is mounted without a renderer')
  assert.equal(report.guest.present, false)
  assert.ok(typeof report.selfTest === 'string')
})

test('the locale probe reports the active language and the resolved copy', async () => {
  const { plugin } = await createInstance()
  const harness = createFakeCtx()
  plugin.apply(harness.ctx)

  const registration = harness.inspectProviders[0]
  const report = registration.query('locale')
  assert.equal(report.active, 'zh', 'the fake locale activates Chinese')
  assert.ok(report.locales.includes('zh') && report.locales.includes('en'))
  assert.equal(report.sample, '重启保持登录', 'the panel copy resolves through the active locale')
  assert.equal(report.zhSample, '重启保持登录')
  assert.equal(report.enSample, 'Login across restarts')
})

test('switching the DSH language re-renders the panel without a reload', async () => {
  const { plugin, internals } = await createInstance()
  const harness = createFakeCtx()
  plugin.apply(harness.ctx)

  const translate = internals.translator()
  assert.equal(translate('persistLabel'), '重启保持登录', 'the default language is Chinese')
  assert.equal(
    translate('rect', { left: 1, top: 2, width: 3, height: 4 }),
    '左1 上2 3×4',
    'templates interpolate in the active language',
  )

  harness.ctx.__setLocale('en')
  assert.equal(translate('persistLabel'), 'Login across restarts', 'the same translator follows the switch')
  assert.equal(
    translate('rect', { left: 1, top: 2, width: 3, height: 4 }),
    'left 1 top 2 3×4',
    'templates follow the switch too',
  )
})

test('a re-applied bundle takes over the previous instance instead of colliding', async () => {
  const { plugin, internals, window } = await createInstance()

  const first = createFakeCtx()
  plugin.apply(first.ctx)
  assert.equal(first.tabTypes.length, 1, 'the first apply registers its tab type')

  const second = createFakeCtx()
  plugin.apply(second.ctx)

  assert.equal(second.tabTypes.length, 1, 'the second apply registers again, never "already registered"')
  assert.equal(internals.rightSidebarStatus().state, 'registered')
  assert.equal(window.__DSH_CHAT_EMBED_INSTANCE__.version, internals.BUILD, 'the live instance is published')
})

test('the surface paints no absolute geometry: CSS owns the box', async () => {
  const { internals } = await createInstance()

  for (const seat of ['main', 'right']) {
    const tree = internals.ChatSurface({ seat })
    assert.equal(tree.props.className, 'dce-panel dce-inline')
    assert.equal(tree.props['data-mode'], 'inline')
    assert.equal(tree.props['data-seat'], seat)
    assert.equal(tree.props.style, undefined, 'inline mode must not write left/top/width/height')
  }
})

test('a guest whose seat unmounted is rebuilt on the next ensure, not reused', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  const { host } = attachSurface(instance)

  const record = await openTab(instance, 'deepseek')
  const first = record.element

  // The seat (right tab / center panel) went away with the guest inside it.
  instance.document.body.removeChild(host)
  assert.equal(first.isConnected, false)

  const next = instance.document.createElement('div')
  instance.document.body.appendChild(next)
  instance.internals.updateSurface({ host: next })
  await instance.internals.ensureActiveGuest()

  assert.notEqual(guestOf(instance, 'deepseek').element, first, 'a detached guest is not treated as live')
  assert.equal(shell.calls.acquire.length, 2)
})

test('a collapsed right tab never steals the chat from a visible seat', async () => {
  const { internals, document } = await createInstance()

  const visible = document.createElement('div')
  visible.rect = { left: 0, top: 40, width: 1200, height: 760 }
  const hidden = document.createElement('div')
  hidden.rect = { left: 0, top: 0, width: 0, height: 0 }
  internals.inlineHosts.main = visible
  internals.inlineHosts.right = hidden

  // No explicit choice yet: the painted seat wins over the collapsed one.
  assert.equal(internals.inlineSeat(), 'main')

  // Even an explicit right-tab choice keeps the page in the visible seat while
  // the column is collapsed; the page must never be painted into 0x0.
  internals.preferSeat('right')
  assert.equal(internals.inlineSeat(), 'main')

  // Once the column gives the tab a box, the chosen seat takes over.
  hidden.rect = { left: 700, top: 40, width: 480, height: 760 }
  assert.equal(internals.inlineSeat(), 'right')
})

test('a preferred but not yet registered seat still renders its viewport', async () => {
  const { internals, document } = await createInstance()

  // The right tab is registered and the user then opened the center panel: the
  // center seat is preferred but has not registered itself yet. It must render
  // the viewport (so the registration effect can run) instead of the card.
  const right = document.createElement('div')
  right.rect = { left: 700, top: 40, width: 480, height: 760 }
  internals.inlineHosts.right = right
  internals.preferSeat('main')

  const find = (node, predicate) => {
    if (node === null || node === undefined || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    const children = Array.isArray(node.children) ? node.children : []
    for (const child of children) {
      const hit = find(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }

  const tree = internals.ChatSurface({ seat: 'main' })
  const card = find(tree, (node) => node.props !== undefined && node.props.className === 'dce-launcher')
  const viewport = find(tree, (node) => node.props !== undefined && node.props.className === 'dce-viewport')
  assert.equal(card, undefined, 'the preferred seat must not show the hand-off card')
  assert.ok(viewport !== undefined, 'the preferred seat renders its viewport so it can register as host')
})

test('the seat the user opens is the one that hosts the chat', async () => {
  const { internals, document } = await createInstance()

  const right = document.createElement('div')
  right.rect = { left: 700, top: 40, width: 480, height: 760 }
  const center = document.createElement('div')
  center.rect = { left: 0, top: 40, width: 1200, height: 760 }
  internals.inlineHosts.right = right
  internals.inlineHosts.main = center

  internals.preferSeat('main')
  assert.equal(internals.inlineSeat(), 'main', 'the left entry shows the chat in the center panel')
  assert.equal(internals.getSurface().host, center)
  assert.equal(internals.hostsInline('main'), true)
  assert.equal(internals.hostsInline('right'), false)

  internals.preferSeat('right')
  assert.equal(internals.inlineSeat(), 'right', 'selecting the right tab moves the chat there')
  assert.equal(internals.getSurface().host, right)

  internals.inlineHosts.right = null
  internals.preferSeat('main')
  assert.equal(internals.inlineSeat(), 'main')
})

test('the right sidebar tab body wins the guest host over the center page', async () => {
  const { internals, document } = await createInstance()

  const right = document.createElement('div')
  right.rect = { left: 700, top: 40, width: 480, height: 760 }
  const center = document.createElement('div')
  center.rect = { left: 0, top: 40, width: 1200, height: 760 }

  internals.inlineHosts.right = right
  internals.inlineHosts.main = center

  assert.equal(internals.resolveInlineHost(), right, 'the persistent right tab hosts the guests')
  assert.equal(internals.getSurface().host, right)
  assert.equal(internals.inlineSeat(), 'right')
  assert.equal(internals.hostsInline('right'), true)
  assert.equal(internals.hostsInline('main'), false)

  internals.inlineHosts.right = null
  assert.equal(internals.resolveInlineHost(), center, 'the center page takes over when the tab closes')
  assert.equal(internals.inlineSeat(), 'main')

  internals.inlineHosts.main = null
  assert.equal(internals.resolveInlineHost(), null)
  assert.equal(internals.getSurface().host, null, 'no host means no guest surface')
  assert.equal(internals.inlineSeat(), undefined)
})

test('apply registers the right sidebar tab, its chip title, and a header control', async () => {
  const { plugin, internals } = await createInstance()
  const harness = createFakeCtx()

  plugin.apply(harness.ctx)

  const body = harness.registrations.find((entry) => entry.options.name === internals.RIGHT_TAB_SLOT)
  const title = harness.registrations.find((entry) => entry.options.name === internals.RIGHT_TAB_TITLE_SLOT)
  const dock = harness.registrations.find((entry) => entry.options.name === internals.DOCK_SLOT)

  assert.ok(body !== undefined, 'the tab body seat is registered')
  assert.equal(body.options.key, internals.RIGHT_TAB_ID)
  assert.ok(title !== undefined, 'the chip title seat is registered')
  assert.equal(title.options.key, internals.RIGHT_TAB_ID)
  assert.ok(dock !== undefined, 'the header control is registered')

  assert.equal(harness.tabTypes.length, 1, 'exactly one tab type is registered')
  assert.equal(harness.tabTypes[0].kind, internals.RIGHT_TAB_KIND)
  assert.equal(harness.tabTypes[0].id, internals.RIGHT_TAB_ID)
  assert.equal(harness.tabTypes[0].multiple, false, 'one chat tab per pane')
  assert.equal(harness.tabTypes[0].keepMounted, true, 'a hidden tab keeps its body mounted')
  assert.equal(harness.tabTypes[0].guide.length, 1, 'the sidebar launcher gets an entry')

  const status = internals.rightSidebarStatus()
  assert.equal(status.state, 'registered')
  assert.deepEqual(
    status.seats.map((seat) => seat.label + (seat.ok === true ? ':ok' : ':x')),
    ['body:ok', 'title:ok', 'dock:ok'],
  )

  internals.openRightTab()
  assert.deepEqual(harness.openedTabs, [internals.RIGHT_TAB_KIND], 'the header control opens the tab')
})

test('a rejected right-sidebar seat never takes the plugin down', async () => {
  const { plugin, internals } = await createInstance()
  const harness = createFakeCtx({ rejectSlots: ['conversation.session.header.utilities'] })

  assert.doesNotThrow(() => plugin.apply(harness.ctx), 'apply must stay defensive')

  const status = internals.rightSidebarStatus()
  const dock = status.seats.find((seat) => seat.label === 'dock')
  assert.equal(dock.ok, false, 'the rejected seat is reported, not thrown')
  assert.equal(status.seats.filter((seat) => seat.ok === true).length, 2)
  assert.equal(harness.tabTypes.length, 1, 'the tab type still registers')
  assert.ok(
    harness.registrations.some((entry) => entry.options.name === 'sidebar.panellist'),
    'the left navigation entry is unaffected',
  )
})

test('a missing right sidebar is reported as waiting instead of fatal', async () => {
  const { plugin, internals } = await createInstance()
  const harness = createFakeCtx({ rightSidebar: false })

  assert.doesNotThrow(() => plugin.apply(harness.ctx))
  const status = internals.rightSidebarStatus()
  assert.equal(status.state, 'waiting')
  assert.equal(harness.tabTypes.length, 0)
  assert.ok(harness.injected.includes('sidebar.panellist'))
})

test('the settings menu styles are present', async () => {
  const { internals } = await createInstance()
  const css = internals.CSS

  assert.match(css, /\.dce-switch\[data-on="true"\]\{background:/, 'switches show an on state')
  assert.match(
    css,
    /\.dce-menu\{[^}]*max-width:min\(420px,calc\(100% - 12px\)\)/,
    'the settings menu must cap its width so a long path cannot stretch it',
  )
  assert.match(css, /\.dce-confirm-scrim\{position:absolute;inset:0/, 'the confirm dialog dims the panel')
  assert.match(css, /\.dce-card\[data-modal="true"\]\{z-index:8\}/, 'the confirm dialog sits above the menu')
  assert.match(css, /\.dce-menu\{position:absolute/, 'the menu floats above the page')
  assert.match(css, /\.dce-menu-scrim\{position:absolute;inset:0/, 'a scrim closes the menu on outside clicks')
})

test('a stored order drops unknown and duplicate ids', async () => {
  const storage = new FakeStorage()
  storage.setItem('dsh-chat-embed:tab-order', JSON.stringify(['ghost', 'grok', 'grok', 'kimi']))

  const instance = await createInstance({ storage })
  const order = instance.internals.getTabOrder()

  assert.equal(order[0], 'grok')
  assert.equal(order[1], 'kimi')
  assert.ok(!order.includes('ghost'), 'unknown ids must be dropped')
  assert.equal(order.length, instance.internals.PROVIDERS.length, 'every provider appears exactly once')
  assert.equal(new Set(order).size, order.length)
})

test('an unknown stored tab falls back to the default provider', async () => {
  const storage = new FakeStorage()
  storage.setItem('dsh-chat-embed:active-tab', 'not-a-provider')

  const instance = await createInstance({ storage })
  assert.equal(instance.internals.activeProvider().id, instance.internals.DEFAULT_PROVIDER)
})

// ---------------------------------------------------------------------------
// Surface geometry and the panel-switch invariant
// ---------------------------------------------------------------------------

test('ensureActiveGuest waits for a host viewport', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  const document = instance.document

  await instance.internals.ensureActiveGuest()
  assert.equal(shell.calls.acquire.length, 0, 'no lease before a host exists')

  const host = document.createElement('div')
  document.body.appendChild(host)
  instance.internals.updateSurface({ host })
  await instance.internals.ensureActiveGuest()
  assert.equal(shell.calls.acquire.length, 1)
})

test('a blank OAuth callback is recovered by loading the entry URL', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  attachSurface(instance)
  instance.internals.TIMINGS.oauthLandingDelayMs = 5
  instance.internals.TIMINGS.oauthBlankWatchMs = 5000

  const record = await openTab(instance, 'chatgpt')
  record.element.fire('dom-ready')
  await waitFor(() => record.phase === 'ready')

  /** @type {string[]} */
  const executed = []
  record.element.executeJavaScript = async (code) => {
    executed.push(code)
    if (code.indexOf('JSON.stringify({text') !== -1) return JSON.stringify({ text: '' })
    return true
  }

  shell.emitOpenRequested('lease-1', 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x')
  record.element.fire('did-navigate', { url: 'https://chatgpt.com/oauth/callback?code=abc' })

  await waitFor(() => executed.indexOf('location.href = "https://chatgpt.com/";') !== -1, 3000)
  assert.equal(record.oauthPending, false, 'the OAuth tracking clears once recovery ran')
})

test('a full-page OAuth redirect is tracked without any popup', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  attachSurface(instance)
  instance.internals.TIMINGS.oauthLandingDelayMs = 5
  instance.internals.TIMINGS.oauthBlankWatchMs = 5000

  const record = await openTab(instance, 'chatgpt')
  record.element.fire('dom-ready')
  await waitFor(() => record.phase === 'ready')

  /** @type {string[]} */
  const executed = []
  record.element.executeJavaScript = async (code) => {
    executed.push(code)
    if (code.indexOf('JSON.stringify({text') !== -1) return JSON.stringify({ text: '' })
    return true
  }

  record.element.fire('did-navigate', { url: 'https://accounts.google.com/signin/oauth/consent' })
  assert.equal(record.oauthPending, true, 'the IdP hop must arm recovery')

  record.element.fire('did-navigate', { url: 'https://chatgpt.com/oauth/callback?code=x' })
  await waitFor(() => executed.indexOf('location.href = "https://chatgpt.com/";') !== -1, 3000)
})

test('a GSI transform landing is a dead end that reloads onto the site', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  attachSurface(instance)
  instance.internals.TIMINGS.oauthHandoffProbeMs = 5
  instance.internals.TIMINGS.oauthRecoveryReloadMs = 5

  const record = await openTab(instance, 'chatgpt')
  const element = record.element
  element.executeJavaScript = async (code) => {
    if (code.indexOf('location.hash') !== -1) return JSON.stringify({ hash: 0, search: 0, keys: [] })
    return true
  }
  element.url = 'https://accounts.google.com/gsi/transform'

  element.fire('did-stop-loading')

  assert.equal(record.oauthBlocked, true, 'the card explains the dead end')
  await waitFor(() => shell.calls.acquire.length === 2, 2000)
  assert.equal(record.mounts, 2, 'a fresh guest replaces the stuck document')
  assert.equal(record.oauthBlocked, true, 'the explanation survives the recovery reload')
  await waitFor(() => record.handoff !== '', 2000)
  assert.match(record.handoff, /^\{"hash":0/, 'the handoff probe result is kept across the reload')
})

test('a rendered OAuth callback is left alone', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  attachSurface(instance)
  instance.internals.TIMINGS.oauthLandingDelayMs = 5
  instance.internals.TIMINGS.oauthBlankWatchMs = 5000

  const record = await openTab(instance, 'chatgpt')
  record.element.fire('dom-ready')
  await waitFor(() => record.phase === 'ready')

  /** @type {string[]} */
  const executed = []
  record.element.executeJavaScript = async (code) => {
    executed.push(code)
    if (code.indexOf('JSON.stringify({text') !== -1) {
      return JSON.stringify({ text: 'Welcome back — your chats are here.' })
    }
    return true
  }

  shell.emitOpenRequested('lease-1', 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x')
  record.element.fire('did-navigate', { url: 'https://chatgpt.com/oauth/callback?code=abc' })
  await new Promise((resolve) => setTimeout(resolve, 120))

  assert.equal(executed.indexOf('location.href = "https://chatgpt.com/";'), -1, 'a rendered page must not be reloaded')
})

test('an OAuth popup arms the dead-end tracking', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  attachSurface(instance)

  const record = await openTab(instance, 'chatgpt')
  record.element.fire('dom-ready')
  await waitFor(() => record.phase === 'ready')
  assert.equal(record.oauthPending, false)

  shell.emitOpenRequested('lease-1', 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x')

  assert.equal(record.oauthPending, true, 'an identity-provider popup arms the dead-end tracking')
  assert.equal(record.element.executed.at(-1), 'location.href = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x";')
})

test('a non-OAuth popup does not arm the tracking', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  attachSurface(instance)

  const record = await openTab(instance, 'chatgpt')
  record.element.fire('dom-ready')
  await waitFor(() => record.phase === 'ready')

  shell.emitOpenRequested('lease-1', 'https://docs.anthropic.com/en/docs')

  assert.equal(record.oauthPending, false, 'ordinary links must not be treated as sign-in')
})

test('the guest carries allowpopups so OAuth buttons can report their URL', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  attachSurface(instance)

  const record = await openTab(instance, 'chatgpt')

  assert.ok(record.element.hasAttribute('allowpopups'), 'without allowpopups the shell never sees the popup request')
})

test('a relayed popup request continues in the same guest', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  attachSurface(instance)

  const record = await openTab(instance, 'chatgpt')
  record.element.fire('dom-ready')
  await waitFor(() => record.phase === 'ready')

  shell.emitOpenRequested('lease-1', 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x')

  assert.equal(record.element.executed.at(-1), 'location.href = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x";')
  assert.equal(record.mounts, 1, 'a popup must not recreate the guest')
})

test('a non-https popup request is ignored', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  attachSurface(instance)

  const record = await openTab(instance, 'chatgpt')
  record.element.fire('dom-ready')
  await waitFor(() => record.phase === 'ready')
  const before = record.element.executed.length

  shell.emitOpenRequested('lease-1', 'http://insecure.test/')
  shell.emitOpenRequested('lease-1', 'javascript:alert(1)')

  assert.equal(record.element.executed.length, before)
})

test('the popup listener is released with its guest', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  attachSurface(instance)

  await openTab(instance, 'chatgpt')
  assert.equal(shell.listenerCount('lease-1'), 1)

  await instance.internals.reloadGuest('chatgpt')
  assert.equal(shell.listenerCount('lease-1'), 0, 'a consumed lease must not keep a listener')
  assert.equal(shell.listenerCount('lease-2'), 1, 'the fresh lease gets its own listener')

  instance.internals.destroyGuests()
  assert.equal(shell.listenerCount('lease-2'), 0)
})

test('the start URL prefers the conversation a service was last on', async () => {
  const { internals } = await createInstance()
  const provider = internals.findProvider('deepseek')
  assert.equal(internals.startUrlFor(provider), provider.url, 'cold start opens the service home')

  internals.lastUrls.set('deepseek', 'https://chat.deepseek.com/a/chat/s/abc123')
  assert.equal(internals.startUrlFor(provider), 'https://chat.deepseek.com/a/chat/s/abc123')

  internals.lastUrls.set('deepseek', 'https://accounts.google.com/signin/oauth/consent')
  assert.equal(internals.startUrlFor(provider), provider.url, 'a foreign origin never becomes the start URL')

  internals.lastUrls.set('deepseek', 'about:blank')
  assert.equal(internals.startUrlFor(provider), provider.url, 'a non-live URL is ignored')
})

test('a rebuilt guest reopens the conversation it was last on', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  const { host } = attachSurface(instance)

  const record = await openTab(instance, 'deepseek')
  const first = record.element
  const deep = 'https://chat.deepseek.com/a/chat/s/abc123'
  record.element.fire('did-navigate-in-page', { url: deep })

  // Simulate the surface being torn down under the guest (tab closed/reopened).
  instance.document.body.removeChild(host)
  assert.equal(first.isConnected, false)
  instance.internals.updateSurface({ host })
  await instance.internals.mountGuest('deepseek')

  const rebuilt = guestOf(instance, 'deepseek').element
  assert.notEqual(rebuilt, first, 'a torn-down guest is rebuilt')
  rebuilt.fire('dom-ready')
  await waitFor(() => rebuilt.executed.length > 0)
  assert.ok(
    rebuilt.executed.some((code) => code.includes(JSON.stringify(deep))),
    'the rebuilt guest navigates straight back to the remembered conversation',
  )
})

test('a guest whose host was torn down is rebuilt instead of reused', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  const { host } = attachSurface(instance)

  const record = await openTab(instance, 'deepseek')
  const first = record.element

  // Simulate React dropping the host (plugin reload) under the guest.
  instance.document.body.removeChild(host)
  assert.equal(first.isConnected, false)

  instance.internals.updateSurface({ host })
  await instance.internals.mountGuest('deepseek')

  assert.notEqual(guestOf(instance, 'deepseek').element, first)
  assert.equal(shell.calls.acquire.length, 2)
  assert.deepEqual(shell.calls.release, ['lease-1'])
})

// ---------------------------------------------------------------------------
// Debug log: off by default, one click on, nothing printed while off
// ---------------------------------------------------------------------------

/** Capture everything the plugin prints to the console. */
function captureConsole() {
  const lines = []
  const original = { log: console.log, warn: console.warn, error: console.error }
  const push = (...args) => lines.push(args.map((value) => String(value)).join(' '))
  console.log = push
  console.warn = push
  console.error = push
  return {
    lines,
    restore() {
      console.log = original.log
      console.warn = original.warn
      console.error = original.error
    },
  }
}

test('the debug log is off by default and records nothing', async () => {
  const { internals } = await createInstance()
  const capture = captureConsole()
  try {
    assert.equal(internals.getLogging(), false, 'logging starts off')
    internals.log('info', 'invisible', { a: 1 })
    assert.deepEqual(internals.readLogEntries(), [], 'nothing is buffered while off')
    assert.deepEqual(capture.lines, [], 'nothing is printed while off')
  } finally {
    capture.restore()
  }
})

test('one click turns the debug log on, prints, buffers and persists', async () => {
  const { internals, storage } = await createInstance()
  const capture = captureConsole()
  try {
    internals.setLogging(true)
    assert.equal(internals.getLogging(), true)
    assert.equal(storage.getItem('dsh-chat-embed:log'), '1', 'the switch is remembered')

    internals.log('warn', 'hello', { n: 1 })
    const entries = internals.readLogEntries()
    assert.equal(entries.length, 2, 'enabling writes one entry, then the event')
    assert.equal(entries[1].level, 'warn')
    assert.equal(entries[1].message, 'hello')
    assert.deepEqual(entries[1].detail, { n: 1 })
    assert.ok(
      capture.lines.some((line) => line.includes('hello')),
      'an enabled log reaches the console',
    )

    internals.setLogging(false)
    assert.equal(storage.getItem('dsh-chat-embed:log'), '0')
    const before = internals.readLogEntries().length
    internals.log('info', 'after off')
    assert.equal(internals.readLogEntries().length, before, 'switching off stops recording')
  } finally {
    capture.restore()
  }
})

test('the log probe toggles, reads and clears the buffer', async () => {
  const { plugin } = await createInstance()
  const harness = createFakeCtx()
  plugin.apply(harness.ctx)
  const registration = harness.inspectProviders[0]
  const capture = captureConsole()
  try {
    assert.equal(registration.query('log').enabled, false, 'a fresh instance is off')

    const on = registration.query('log', { enabled: true })
    assert.equal(on.enabled, true)
    assert.ok(on.entries.length >= 1, 'enabling writes one entry')

    registration.query('log', { clear: true })
    assert.deepEqual(registration.query('log').entries, [], 'clear empties the ring buffer')

    const off = registration.query('log', { enabled: false })
    assert.equal(off.enabled, false)
  } finally {
    capture.restore()
  }
})

test('the toolbar keeps only reload, open-in-browser and settings', async () => {
  const { internals } = await createInstance()

  const collect = (node, predicate, out = []) => {
    if (node === null || node === undefined || typeof node !== 'object') return out
    if (node.props !== undefined && predicate(node.props)) out.push(node)
    const children = Array.isArray(node.children) ? node.children : []
    for (const child of children) collect(child, predicate, out)
    return out
  }

  const tree = internals.ChatSurface({ seat: 'main' })
  const toolbar = collect(tree, (props) => props.className === 'dce-icon-button')
  assert.equal(toolbar.length, 3, 'reload + open-in-browser + settings only')
  assert.equal(collect(tree, (props) => props['data-log-toggle'] === 'true').length, 0, 'the log switch moved into the menu')
  assert.equal(collect(tree, (props) => props['aria-label'] === 'Tab diagnostics').length, 0, 'the diagnostics entry moved into the menu')
})

test('the panel shows its own version, so a screenshot identifies the build', async () => {
  const { internals } = await createInstance()

  const collect = (node, predicate, out = []) => {
    if (node === null || node === undefined || typeof node !== 'object') return out
    if (node.props !== undefined && predicate(node.props)) out.push(node)
    const children = Array.isArray(node.children) ? node.children : []
    for (const child of children) collect(child, predicate, out)
    return out
  }

  // Opening the menu is a click; the closed tree still carries the title and the
  // version chip only renders with the menu. Assert on the CSS contract plus the
  // diagnostics card, which is always in the tree once opened.
  assert.match(internals.CSS, /\.dce-menu-version\{/, 'the menu title has a version chip')
  assert.match(internals.CSS, /\.dce-card-version\{/, 'the diagnostics card has a version chip')

  const diagnostics = collect(internals.ChatSurface({ seat: 'main' }), (props) => props.className === 'dce-card-version')
  assert.equal(diagnostics.length, 0, 'the diagnostics card is closed by default')

  // The build identity must be the same constant the diagnostics report prints,
  // and it must agree with package.json — a mismatch ships a lying version chip.
  assert.match(internals.BUILD, /^\d+\.\d+\.\d+$/, 'BUILD is a plain semver')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(internals.BUILD, manifest.version, 'client BUILD equals package.json version')
})

test('the settings menu reports whether logins survive a restart', async () => {
  const shell = createFakeShell()
  const instance = await createInstance({ shell })
  attachSurface(instance)

  assert.equal(instance.internals.persistenceState(), 'unknown', 'nothing is known before a guest exists')

  const record = await openTab(instance, 'deepseek')
  assert.equal(instance.internals.persistenceState(), 'off', 'a memory partition means persistence is off')

  record.partition = 'persist:dsh-sidebar-abc'
  assert.equal(instance.internals.persistenceState(), 'on', 'a persist: partition means it is on')
})

test('a patch lost to a shell update is reported as lost, not as a first run', async () => {
  const instance = await createInstance({ shell: createFakeShell() })
  attachSurface(instance)

  // A persistent partition is seen once: the patch was applied and worked.
  const record = await openTab(instance, 'deepseek')
  record.partition = 'persist:dsh-sidebar-abc'
  assert.equal(instance.internals.persistenceState(), 'on')
  assert.equal(instance.internals.readPersistedSeen(), true, 'the run remembers that the patch worked')

  // A shell update replaced app.asar: the next run gets a memory partition.
  record.partition = 'dsh-sidebar-browser-xyz'
  assert.equal(
    instance.internals.persistenceState(),
    'lost',
    'seeing memory after persistent is a lost patch, not a first run',
  )

  // A machine that never had the patch keeps reporting plain "off".
  instance.internals.storePersistenceSeen(false)
  assert.equal(instance.internals.persistenceState(), 'off')
})

test('the instructions hand over the script, not a list of steps', async () => {
  const { internals } = await createInstance()
  const text = internals.patchInstructions((key) => internals.DICTS.zh[key] ?? key)

  assert.match(text, /shell-patch\.mjs apply/, 'the one command that does the job is there')
  assert.match(text, /重新打开 DSH/, 'the restart is the only follow-up asked for')
  assert.doesNotMatch(text, /app\.asar\.new/, 'no hand-staged archive any more')
  assert.doesNotMatch(text, /watchdog/, 'no second script to run afterwards')
  assert.doesNotMatch(text, /改名/, 'nobody renames files by hand')
})

test('the instructions use the launcher the Host located', async () => {
  const { internals } = await createInstance()
  const t = (key) => internals.DICTS.zh[key] ?? key
  const text = internals.patchInstructions(t, {
    launcher: 'C:\\pkg\\tools\\shell-patch\\shell-patch.cmd',
    applyCommand: '"C:\\pkg\\tools\\shell-patch\\shell-patch.cmd" apply',
  })
  assert.match(text, /shell-patch\.cmd/, 'the launcher is named')
  assert.match(text, /apply/, 'and the direction it should take')
  assert.doesNotMatch(text, /node\.exe/, 'no Node binary to think about')
})

test('turning the switch off hands over the revert, not the apply', async () => {
  const instance = await createInstance({ shell: createFakeShell() })
  attachSurface(instance)
  const t = (key) => instance.internals.DICTS.zh[key] ?? key

  const text = instance.internals.patchInstructions(
    t,
    {
      launcher: 'D:\\pkg\\shell-patch.cmd',
      applyCommand: '"D:\\pkg\\shell-patch.cmd" apply',
      revertCommand: '"D:\\pkg\\shell-patch.cmd" revert',
    },
    'off',
  )
  assert.match(text, /revert/, 'the undo direction is handed over')
  assert.doesNotMatch(text, /apply/, 'the enable direction is not repeated')
})

test('the instructions never invent a path the Host did not report', async () => {
  const instance = await createInstance({ shell: createFakeShell() })
  attachSurface(instance)
  const t = (key) => instance.internals.DICTS.zh[key] ?? key

  const text = instance.internals.patchInstructions(t, undefined)
  assert.doesNotMatch(text, /undefined/, 'an absent probe does not leak into the text')
  assert.doesNotMatch(text, /C:\\|\/Applications\//, 'no invented install path')
  assert.match(text, /shell-patch\.mjs apply/, 'the fallback is still a runnable command')
})

// ---------------------------------------------------------------------------
// The switch runs the script; the dialog is the fallback
// ---------------------------------------------------------------------------

/** A fetch stand-in: records every call and answers from `handler`. */
async function withFetch(handler, body) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  const calls = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    calls.push({ url: target, init: init ?? {} })
    return handler(target)
  }
  try {
    await body(calls)
  } finally {
    if (previous === undefined) delete globalThis.fetch
    else Object.defineProperty(globalThis, 'fetch', previous)
  }
}

/** @param {any} value @returns {{ ok: boolean, json: () => Promise<any> }} */
function jsonAnswer(value) {
  return { ok: true, status: 200, json: async () => value }
}

/** The probe the Host answers when it can run the script itself. */
const PROBE_WITH_ROUTE = {
  found: true,
  patched: false,
  patchSite: true,
  writable: true,
  resources: 'C:\\DSH\\resources',
  script: 'C:\\pkg\\shell-patch.mjs',
  launcher: 'C:\\pkg\\shell-patch.cmd',
  applyCommand: '"C:\\pkg\\shell-patch.cmd" apply',
  revertCommand: '"C:\\pkg\\shell-patch.cmd" revert',
  token: 'tok-abc',
}

/** Walk a vnode tree. @param {any} node @param {(props: any) => boolean} predicate @param {any[]} [out] */
function collectNodes(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (node.props !== undefined && predicate(node.props)) out.push(node)
  const children = Array.isArray(node.children) ? node.children : []
  for (const child of children) collectNodes(child, predicate, out)
  return out
}

test('the switch keeps exactly the state a running action needs', async () => {
  const { internals } = await createInstance()

  // The switch tracks "an action is in flight" and "a script is waiting for DSH
  // to exit". Nothing about a previous answer can be replayed from here.
  assert.deepEqual(Object.keys(internals.patchAction).sort(), ['action', 'pending', 'running'])
  assert.equal(internals.patchAction.running, false)
  assert.equal(internals.patchAction.pending, false)
})

test('the switch starts the script instead of handing over a command', async () => {
  const instance = await createInstance({ shell: createFakeShell() })
  attachSurface(instance)
  const t = (key) => instance.internals.DICTS.zh[key] ?? key

  await withFetch(
    (url) => jsonAnswer(url.includes('patch-check') ? PROBE_WITH_ROUTE : { ok: true, state: 'started', action: 'apply' }),
    async (calls) => {
      const outcome = await instance.internals.startPatchAction(t, 'on')

      assert.equal(outcome.lead, '', 'a started action needs no dialog at all')
      assert.equal(instance.internals.patchAction.pending, true, 'the panel knows a script is waiting')
      const asked = calls.filter((call) => call.url.includes('/patch?'))
      assert.equal(asked.length, 1, 'one request starts it')
      assert.match(asked[0].url, /action=apply/)
      assert.match(asked[0].url, /token=tok-abc/, 'the token the probe handed out')
      assert.equal(asked[0].init.method, 'GET', 'the carrier behind these routes answers GET only')
    },
  )
})

test('an action that cannot start explains itself and still ships the command', async () => {
  const cases = [
    ['denied', 'patchNeedsAdmin'],
    ['noapp', 'patchNoInstall'],
    ['unsupported', 'patchNoSite'],
    ['same', 'patchSame'],
  ]
  for (const [state, key] of cases) {
    const instance = await createInstance({ shell: createFakeShell() })
    attachSurface(instance)
    const t = (k) => instance.internals.DICTS.zh[k] ?? k
    await withFetch(
      (url) => jsonAnswer(url.includes('patch-check') ? PROBE_WITH_ROUTE : { ok: false, state, detail: '' }),
      async () => {
        const outcome = await instance.internals.startPatchAction(t, 'on')
        assert.equal(outcome.lead, t(key), state + ' names its own reason')
        assert.equal(outcome.script, PROBE_WITH_ROUTE.launcher, 'the dialog still knows what to name')
        assert.equal(instance.internals.patchAction.pending, false, state + ' claims nothing is waiting')
      },
    )
  }
})

test('a Host without the action route falls back to the copyable command', async () => {
  const instance = await createInstance({ shell: createFakeShell() })
  attachSurface(instance)
  const t = (key) => instance.internals.DICTS.zh[key] ?? key

  await withFetch(
    () => jsonAnswer({ found: true, launcher: 'C:\\pkg\\shell-patch.cmd', applyCommand: 'a', revertCommand: 'r' }),
    async (calls) => {
      const outcome = await instance.internals.startPatchAction(t, 'on')
      assert.equal(outcome.lead, t('patchNoRoute'))
      assert.equal(
        calls.filter((call) => call.url.includes('/patch?')).length,
        0,
        'it never calls a route the Host does not serve',
      )
    },
  )
})

test('a pending patch asks the user to quit DSH from the tray', async () => {
  const instance = await createInstance({ shell: createFakeShell() })
  attachSurface(instance)
  const surface = () => instance.internals.ChatSurface({ seat: 'main' })

  assert.equal(
    collectNodes(surface(), (props) => props['data-patch-pending'] === 'true').length,
    0,
    'a healthy tab shows no strip',
  )

  instance.internals.patchAction.pending = true
  assert.equal(
    collectNodes(surface(), (props) => props['data-patch-pending'] === 'true').length,
    1,
    'the strip appears while the script waits for the exit',
  )
  // It has to clear the tab bar: the pending state pins the tab bar open, and
  // the tab bar owns the same top edge with a higher z-index, so a strip left on
  // top:0 is covered by the very state it reports. That is exactly how the first
  // click appeared to do nothing.
  const pendingCss = instance.internals.CSS.match(/\.dce-status-bar\[data-patch-pending="true"\]\{[^}]*\}/)
  assert.ok(pendingCss !== null, 'the pending strip has its own position')
  assert.doesNotMatch(pendingCss[0], /top:0[;}]/, 'it does not sit under the tab bar')
  assert.match(pendingCss[0], /z-index:5/, 'and it paints above the tab bar')
  assert.match(instance.internals.DICTS.zh.patchPendingHint, /托盘/, 'zh says where to quit')
  assert.match(instance.internals.DICTS.en.patchPendingHint, /tray/, 'en says where to quit')
})

test('one row opens a dialog that hands over the script', async () => {
  const { internals } = await createInstance()
  const t = (key) => internals.DICTS.zh[key] ?? key

  assert.equal(typeof internals.copyPatchCommand, 'function', 'one action hands over the command')
  assert.ok(t('persistCheckHint').length > 0, 'the button explains what a click does')
  assert.match(internals.CSS, /\.dce-switch\{/, 'the row uses the shared switch styling')

  assert.doesNotMatch(internals.CSS, /\.dce-menu-note/, 'no inline note survives')
  assert.doesNotMatch(internals.CSS, /data-patch-report/, 'the inline report styling is gone')
  assert.match(internals.CSS, /\.dce-confirm-scrim\{position:absolute;inset:0/, 'the dialog dims the panel')
  assert.match(internals.CSS, /\.dce-card\[data-modal="true"\]\{z-index:8\}/, 'the dialog sits above the menu')

  for (const key of ['persistConfirmTitle', 'persistConfirmNote', 'persistConfirmGo', 'persistConfirmCancel']) {
    assert.ok(t(key).length > 0, key + ' is translated in zh')
    assert.ok(internals.DICTS.en[key].length > 0, key + ' is translated in en')
  }
  assert.ok(t('persistRisk').length > 0, 'the dialog carries the experimental warning')
  // No agent is involved any more: the note must not promise a session.
  assert.doesNotMatch(t('persistConfirmNote'), /新会话/, 'the dialog does not open a session')
  assert.match(t('persistConfirmNote'), /脚本/, 'it names the script instead')
})
test('the command text is what a user can act on without help', async () => {
  const instance = await createInstance({ shell: createFakeShell() })
  attachSurface(instance)
  const t = (key) => instance.internals.DICTS.zh[key] ?? key

  const text = instance.internals.patchInstructions(t, {
    launcher: 'D:\\pkg\\shell-patch.cmd',
    applyCommand: '"D:\\pkg\\shell-patch.cmd" apply',
  })
  assert.ok(text.split('\n').length <= 8, 'the whole handover fits on one card: ' + text.split('\n').length + ' lines')
  assert.match(text, /D:\\pkg\\shell-patch\.cmd/, 'the file to double-click is named')
  assert.match(text, /apply/, 'the command is complete, not a fragment')
})

test('a dialog that is still asking does not claim the script is missing', async () => {
  const { internals } = await createInstance()
  const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
  // Three states, not two: undefined while the probe is in flight, '' when it
  // answered "no launcher", a path otherwise. Writing this as a boolean would
  // flash "the script is missing" on every open.
  assert.match(source, /useState\(undefined\)/, 'the dialog starts in the unknown state')
  assert.match(source, /confirmScript === undefined/, 'the unknown state renders nothing')
  assert.ok(internals.DICTS.zh.patchScriptMissing.length > 0, 'and the missing state has its own wording')
})
