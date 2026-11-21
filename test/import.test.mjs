/**
 * Contract tests for the import pipeline.
 *
 * Two channels, one destination: the toolbar pulls an extraction payload back
 * through executeJavaScript, the selection bubble pushes it through the guest
 * console channel (the shell forbids preload, so ipc-message cannot exist).
 * Both end as a draft in the main conversation — never an automatic send.
 *
 * Everything runs against doubles (`test/fake-env.mjs`), offline.
 */

import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import {
  FakeStorage,
  createFakeDocument,
  createFakeShell,
  createInstance,
  resetEnvironment,
  waitFor,
} from './fake-env.mjs'

afterEach(() => {
  resetEnvironment()
})

/**
 * A Client ctx with just enough surface for apply() plus the session services
 * the import pipeline reads lazily.
 * @param {{ quoteAccepted?: boolean, byId?: any, uiSession?: any, scopeNone?: boolean, uiWorkspace?: any }} [options]
 */
function createImportCtx(options = {}) {
  const calls = { quotes: [], inits: [], focuses: 0, notifies: [], forScopes: [] }
  const input = {
    insertQuote(text) {
      calls.quotes.push(text)
      return options.quoteAccepted !== false
    },
    focus() {
      calls.focuses += 1
    },
    notify(level, text) {
      calls.notifies.push([level, text])
    },
  }
  // The plugin reads conversation from its own ctx (declared inject) and hands
  // the retained scope to for(); the scope itself carries no services — a
  // derived scope context does not inherit the plugin's inject list.
  const actx = { id: 's1' }
  const conversation = {
    input: {
      for: (scoped) => {
        calls.forScopes.push(scoped)
        return input
      },
      requestDraftInitialization: (binding, opts) => calls.inits.push([binding, opts]),
    },
  }
  const byId = options.byId === undefined ? { s1: { retainedBy: { mainView: 1 } } } : options.byId
  const ctx = {
    on: () => () => {},
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get: () => undefined,
    inject: (_deps, callback) => {
      callback(ctx)
      return () => {}
    },
    locale: {
      getLocale: () => ({ active: 'zh' }),
      register: () => () => {},
      bind: () => (key) => key,
    },
    slots: { inject: (_name, callback) => callback(), register: () => () => {} },
    sessions: {
      list: { getSnapshot: () => ({ byId }) },
      scope: (id) => (options.scopeNone === true || byId[id] === undefined ? undefined : actx),
      binding: (id) => ({ id }),
    },
    uiSession: options.uiSession,
    uiWorkspace: options.uiWorkspace,
    conversation,
  }
  return { ctx, calls }
}

/**
 * One instance with a connected DeepSeek guest whose evaluate double answers
 * extraction calls with `payload` and navigations with a live URL.
 * @param {{ payload?: any, storage?: FakeStorage, ctxOptions?: any }} [options]
 */
async function readyInstance(options = {}) {
  const shell = createFakeShell()
  const payload =
    options.payload === undefined
      ? { ok: true, title: 'DeepSeek', messages: [{ role: 'user', text: '1+1=?' }, { role: 'assistant', text: '2' }] }
      : options.payload
  const document = createFakeDocument({
    webview: {
      evaluate(code, node) {
        if (code.indexOf('location.href') === 0) {
          node.url = 'https://chat.deepseek.com/'
          return true
        }
        if (code.indexOf('dceMd') !== -1) return payload
        return true
      },
    },
  })
  const instance = await createInstance({ shell, document, storage: options.storage })
  const viewport = document.createElement('div')
  viewport.className = 'dce-viewport'
  viewport.rect = { left: 0, top: 40, width: 1200, height: 760 }
  document.body.appendChild(viewport)
  instance.internals.inlineHosts.main = viewport
  instance.internals.preferSeat('main')
  const harness = createImportCtx(options.ctxOptions)
  instance.plugin.apply(harness.ctx)
  await instance.internals.setActive('deepseek')
  const record = instance.internals.guestRecord('deepseek', 'main')
  await waitFor(() => record.element !== undefined && record.element !== null)
  // The double does not emit lifecycle events on its own; the suite drives them.
  record.element.fire('dom-ready')
  await waitFor(() => instance.internals.getStatus('main').phase === instance.internals.PHASE.READY)
  return { instance, harness }
}

test('adapters serialize self-contained guest source', async () => {
  const { internals } = await createInstance()
  const expected = { deepseek: '.ds-markdown', chatgpt: '[data-message-author-role]', gemini: 'user-query' }
  for (const [provider, marker] of Object.entries(expected)) {
    const adapter = internals.GUEST_ADAPTERS[provider]
    assert.notEqual(adapter, undefined, provider + ' adapter is registered')
    for (const kind of ['conversation', 'lastRound', 'selection']) {
      const source = internals.extractionSource(adapter, kind)
      assert.ok(source.indexOf('dceMd') !== -1, provider + '/' + kind + ': prelude travels with the adapter')
      assert.ok(source.indexOf('setInterval') === -1, provider + '/' + kind + ': guest code stays event-driven')
      assert.ok(source.indexOf('(document)') !== -1)
    }
    assert.ok(
      internals.extractionSource(adapter, 'conversation').indexOf(marker) !== -1,
      provider + ' extraction uses its public structural hook',
    )
  }
  const bootstrap = internals.bootstrapSource('nonce-1', '导入到 DSH')
  const shared = internals.extractionSource(internals.GUEST_ADAPTERS.gemini, 'selection')
  assert.ok(shared.indexOf('application/x-tex') !== -1, 'math source comes from the TeX annotation')
  assert.ok(shared.indexOf('cloneContents') !== -1, 'selections serialize the range, not the flattened text')
  assert.ok(shared.indexOf('dceMathRange') !== -1, 'formula boundaries grow to the whole math wrapper')
  assert.ok(bootstrap.indexOf(JSON.stringify(internals.IMPORT_PREFIX)) !== -1)
  assert.ok(bootstrap.indexOf('nonce-1') !== -1)
  assert.ok(bootstrap.indexOf('dceMd') !== -1, 'the bubble serializes with the math-aware walker')
  assert.ok(bootstrap.indexOf('dceTex') !== -1, 'the prelude rides along with the bubble')
  assert.ok(bootstrap.indexOf('dsh-chat-embed.invalid') !== -1, 'the popup relay fallback ships with the bubble')
  assert.ok(bootstrap.indexOf('empty-at-click') !== -1, 'an empty capture must leave a trace')
  assert.ok(bootstrap.indexOf("'pointerup'") !== -1, 'the push fires on release, not on click')
})

test('parseImportMessage accepts only the current mount nonce', async () => {
  const { internals } = await createInstance()
  const line = (nonce, body) => internals.IMPORT_PREFIX + nonce + JSON.stringify(body)
  const parsed = internals.parseImportMessage(line('n1', { kind: 'selection', text: ' hi ' }), 'n1')
  assert.deepEqual(parsed, { kind: 'selection', text: 'hi' })
  assert.equal(internals.parseImportMessage(line('n2', { kind: 'selection', text: 'hi' }), 'n1'), undefined)
  assert.equal(internals.parseImportMessage(line('n1', { kind: 'other', text: 'hi' }), 'n1'), undefined)
  assert.equal(internals.parseImportMessage(line('n1', { kind: 'selection', text: '  ' }), 'n1'), undefined)
  assert.equal(internals.parseImportMessage(internals.IMPORT_PREFIX + 'n1{broken', 'n1'), undefined)
  assert.equal(internals.parseImportMessage('ordinary console line', 'n1'), undefined)
  assert.equal(internals.parseImportMessage(undefined, 'n1'), undefined)
})

test('validateImportPayload rejects malformed extractions', async () => {
  const { internals } = await createInstance()
  const good = { ok: true, messages: [{ role: 'assistant', text: '2' }] }
  assert.equal(internals.validateImportPayload(good), true)
  assert.equal(internals.validateImportPayload({ ok: false, reason: 'no-blocks' }), false)
  assert.equal(internals.validateImportPayload({ ok: true, messages: [] }), false)
  assert.equal(internals.validateImportPayload({ ok: true, messages: [{ role: 'system', text: 'x' }] }), false)
  assert.equal(internals.validateImportPayload({ ok: true, messages: [{ role: 'user', text: ' ' }] }), false)
  assert.equal(internals.validateImportPayload(null), false)
})

test('formatImport labels roles and names the source', async () => {
  const { internals } = await createInstance()
  const text = internals.formatImport(
    { ok: true, title: 'T', messages: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }, { role: 'excerpt', text: 'e' }] },
    { user: 'User', assistant: 'Assistant', excerpt: 'Excerpt' },
    { label: 'DeepSeek', url: 'https://chat.deepseek.com/' },
  )
  assert.ok(text.indexOf('[DeepSeek] T') === 0)
  assert.ok(text.indexOf('**User**\nq') !== -1)
  assert.ok(text.indexOf('**Assistant**\na') !== -1)
  assert.ok(text.indexOf('**Excerpt**\ne') !== -1)
})

test('mainSessionId prefers the adapter snapshot, then the retain scan', async () => {
  const { internals } = await createInstance()
  const snapshot = { uiSession: { adapter: { current: { getSnapshot: () => ({ key: 's9' }) } } } }
  assert.equal(internals.mainSessionId(snapshot), 's9')
  assert.equal(internals.mainSessionId(createImportCtx().ctx), 's1')
  assert.equal(internals.mainSessionId(createImportCtx({ byId: {} }).ctx), undefined)
  assert.equal(internals.mainSessionId(undefined), undefined)
})

test('importDraft inserts a quote and focuses the main input', async () => {
  const { internals } = await createInstance()
  const harness = createImportCtx()
  const outcome = internals.importDraft(harness.ctx, 'text')
  assert.deepEqual(outcome, { ok: true })
  assert.deepEqual(harness.calls.quotes, ['text'])
  assert.equal(harness.calls.focuses, 1)
  assert.equal(harness.calls.forScopes.length, 1, 'the plugin ctx resolves the composer for the retained scope')
  assert.equal(harness.calls.inits.length, 0)
})

test('importDraft appends instead of overwriting when quotes are refused', async () => {
  const { internals } = await createInstance()
  const harness = createImportCtx({ quoteAccepted: false })
  const outcome = internals.importDraft(harness.ctx, 'text')
  assert.deepEqual(outcome, { ok: true })
  assert.equal(harness.calls.inits.length, 1)
  assert.equal(harness.calls.inits[0][1].whenDraftExists, 'append')
  assert.equal(harness.calls.inits[0][1].prompt, 'text')
})

test('importDraft reports a missing main conversation', async () => {
  const { internals } = await createInstance()
  const harness = createImportCtx({ byId: {} })
  assert.deepEqual(internals.importDraft(harness.ctx, 'text'), { ok: false, reason: 'no-session' })
  assert.deepEqual(internals.importDraft({}, 'text'), { ok: false, reason: 'no-session' })
})

test('the toolbar pull import drafts the extracted conversation', async () => {
  const { instance, harness } = await readyInstance()
  await instance.internals.runImport('conversation', 'main')
  assert.equal(harness.calls.quotes.length, 1)
  const draft = harness.calls.quotes[0]
  assert.ok(draft.indexOf('[DeepSeek]') === 0)
  assert.ok(draft.indexOf('1+1=?') !== -1)
  assert.ok(draft.indexOf('2') !== -1)
  const element = instance.internals.guestRecord('deepseek', 'main').element
  assert.ok(element.executed.some((code) => code.indexOf('dceMd') !== -1), 'extraction ran in the guest')
})

test('an empty extraction notifies instead of drafting', async () => {
  const { instance, harness } = await readyInstance({ payload: { ok: false, reason: 'no-blocks', census: '{"counts":{}}' } })
  await instance.internals.runImport('lastRound', 'main')
  assert.equal(harness.calls.quotes.length, 0)
  assert.equal(harness.calls.inits.length, 0)
  const record = instance.internals.guestRecord('deepseek', 'main')
  assert.ok(record.lastEvent.indexOf('import-empty {"counts":{}}') === 0, 'the census lands in diagnostics')
})

test('the selection bubble pushes through the console channel', async () => {
  const { instance, harness } = await readyInstance()
  const record = instance.internals.guestRecord('deepseek', 'main')
  record.element.fire('did-stop-loading')
  await waitFor(() => record.element.executed.some((code) => code.indexOf('guestBootstrapInit') !== -1))
  const line =
    instance.internals.IMPORT_PREFIX + record.importNonce + JSON.stringify({ kind: 'selection', text: 'picked' })
  record.element.fire('console-message', { message: line })
  await waitFor(() => harness.calls.quotes.length === 1)
  assert.ok(harness.calls.quotes[0].indexOf('picked') !== -1)
  assert.ok(harness.calls.quotes[0].indexOf('**摘录**') !== -1)
})

test('a stale nonce cannot feed the current mount', async () => {
  const { instance, harness } = await readyInstance()
  const record = instance.internals.guestRecord('deepseek', 'main')
  const line =
    instance.internals.IMPORT_PREFIX + 'stale-nonce' + JSON.stringify({ kind: 'selection', text: 'picked' })
  record.element.fire('console-message', { message: line })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(harness.calls.quotes.length, 0)
})

test('the bubble preference disarms and re-arms live guests', async () => {
  const storage = new FakeStorage()
  const { instance } = await readyInstance({ storage })
  const record = instance.internals.guestRecord('deepseek', 'main')
  instance.internals.setImportBubbleEnabled(false)
  record.element.fire('did-stop-loading')
  await new Promise((resolve) => setTimeout(resolve, 40))
  const armed = () => record.element.executed.some((code) => code.indexOf('guestBootstrapInit') !== -1)
  const disarmed = () =>
    record.element.executed.some((code) => code.indexOf('__dceImport') !== -1 && code.indexOf('guestBootstrapInit') === -1)
  assert.equal(armed(), false, 'off must not arm the bubble')
  assert.ok(disarmed(), 'off disarms an armed guest')
  instance.internals.setImportBubbleEnabled(true)
  await waitFor(armed)
  assert.equal(storage.getItem(instance.internals.IMPORT_BUBBLE_KEY), 'on')
})

test('foreign console lines are skipped without touching diagnostics', async () => {
  const { instance, harness } = await readyInstance()
  const record = instance.internals.guestRecord('deepseek', 'main')
  const before = record.lastEvent
  record.element.fire('console-message', { message: '%c %s color: yellow; background-color: b' })
  record.element.fire('console-message', { message: 'Error' })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(harness.calls.quotes.length, 0)
  assert.equal(record.lastEvent, before, 'a page log must not overwrite the import trace')
})

test('parsePushUrl round-trips the relayed selection', async () => {
  const { internals } = await createInstance()
  const url = internals.PUSH_URL + encodeURIComponent('n1') + '&' + encodeURIComponent('中文 & 符号')
  assert.deepEqual(internals.parsePushUrl(url), { nonce: 'n1', text: '中文 & 符号' })
  assert.equal(internals.parsePushUrl('https://example.com/x'), undefined)
  assert.equal(internals.parsePushUrl(internals.PUSH_URL + 'n1'), undefined)
  assert.equal(internals.parsePushUrl(internals.PUSH_URL + 'n1&%E0%A4%A'), undefined)
})

test('both channels deliver once within the duplicate window', async () => {
  const { instance, harness } = await readyInstance()
  const record = instance.internals.guestRecord('deepseek', 'main')
  record.element.fire('did-stop-loading')
  await waitFor(() => record.element.executed.some((code) => code.indexOf('guestBootstrapInit') !== -1))
  const line = instance.internals.IMPORT_PREFIX + record.importNonce + JSON.stringify({ kind: 'selection', text: 'same' })
  record.element.fire('console-message', { message: line })
  await waitFor(() => harness.calls.quotes.length === 1)
  const relayed = instance.internals.PUSH_URL + encodeURIComponent(record.importNonce) + '&' + encodeURIComponent('same')
  instance.shell.emitOpenRequested(record.lease, relayed)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(harness.calls.quotes.length, 1, 'the slower channel must not double-import')
})

test('the popup relay delivers even when console never arrives', async () => {
  const { instance, harness } = await readyInstance()
  const record = instance.internals.guestRecord('deepseek', 'main')
  const relayed = instance.internals.PUSH_URL + encodeURIComponent(record.importNonce) + '&' + encodeURIComponent('from-popup')
  instance.shell.emitOpenRequested(record.lease, relayed)
  await waitFor(() => harness.calls.quotes.length === 1)
  assert.ok(harness.calls.quotes[0].indexOf('from-popup') !== -1)
  assert.equal(record.lastEvent, 'import-push popup')
  const stale = instance.internals.PUSH_URL + encodeURIComponent('wrong-nonce') + '&' + encodeURIComponent('stale')
  instance.shell.emitOpenRequested(record.lease, stale)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(harness.calls.quotes.length, 1)
  assert.equal(record.lastEvent, 'import-push stale-nonce')
})

test('an unmounted main session is opened once, then retried once', async () => {
  const { plugin, internals } = await createInstance()
  const opened = []
  const harness = createImportCtx({ scopeNone: true, uiWorkspace: { openSession: (id) => opened.push(id) } })
  // deliverImportPayload reads the module-level activeCtx that apply installs.
  plugin.apply(harness.ctx)
  internals.deliverImportPayload(
    { ok: true, messages: [{ role: 'excerpt', text: 'x' }] },
    { id: 'deepseek', label: 'DeepSeek', url: 'https://chat.deepseek.com/' },
    undefined,
    (key) => key,
  )
  assert.deepEqual(opened, ['s1'], 'navigation retains the session')
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.deepEqual(opened, ['s1'], 'exactly one navigation, no retry loop')
  assert.equal(harness.calls.quotes.length, 0)
})

test('the import menu and bubble switch render in the surface tree', async () => {
  const { instance } = await readyInstance()
  const tree = instance.internals.ChatSurface({ seat: 'main' })
  const json = JSON.stringify(tree)
  assert.ok(json.indexOf('dce-import-notice') === -1, 'no toast without an import')
  instance.internals.showImportNotice(instance.internals.guestRecord('deepseek', 'main'), 'hello')
  const toasted = JSON.stringify(instance.internals.ChatSurface({ seat: 'main' }))
  assert.ok(toasted.indexOf('dce-import-notice') !== -1)
  assert.ok(toasted.indexOf('hello') !== -1)
})