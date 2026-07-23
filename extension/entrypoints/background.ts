import { defineBackground } from 'wxt/utils/define-background'
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings'
import type {
  BackgroundRequest,
  BackgroundResponse,
  NativeEvent,
  NativeRequest,
  NativeResponse,
  NativeStatus,
  SettingsResult,
} from '../src/types'

const HOST_NAME = 'com.browsersdk.assistant'
const SIDEPANEL_PATH = 'sidepanel.html'
const LEGACY_SETTINGS_STORAGE_KEY = 'brosdk-assistant-settings'
const NATIVE_REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_NAVIGATION_TIMEOUT_MS = 15_000
const MAX_NAVIGATION_TIMEOUT_MS = 60_000

type DomSnapshotElement = {
  role: string
  name: string
  tag: string
  text: string
  selector: string
  href?: string
  value?: string
  placeholder?: string
  visible: boolean
}

type DomSnapshotResult = {
  title: string
  url: string
  elements: DomSnapshotElement[]
  truncated: boolean
}

type BrowserDomToolResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

type SnapshotRefTarget = {
  selector: string
  tag: string
  role: string
  name: string
}

type SnapshotState = {
  documentId: string
  revision: number
  refs: Map<string, SnapshotRefTarget>
}

type NavigationWaitResult = {
  status: 'complete' | 'timeout' | 'closed'
  elapsedMs: number
  tab?: chrome.tabs.Tab
}

export default defineBackground(() => {
  let nativePort: chrome.runtime.Port | null = null
  let connected = false
  let lastError: string | undefined
  let cachedSettings: SettingsResult = DEFAULT_SETTINGS
  let snapshotRevision = 0
  const snapshotsByTab = new Map<number, SnapshotState>()
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timeoutId: ReturnType<typeof setTimeout>
    }
  >()

  async function configureSidePanel(nextSettings?: SettingsResult) {
    let settings = nextSettings ? normalizeSettings(nextSettings) : DEFAULT_SETTINGS
    if (!nextSettings) {
      try {
        settings = normalizeSettings(
          (await requestNative(createNativeRequest('settings.get'))) as Partial<SettingsResult>,
        )
      } catch (error) {
        console.warn('[brosdk-assistant] failed to load native settings, using defaults', error)
      }
    }

    try {
      cachedSettings = settings
      await chrome.sidePanel.setPanelBehavior({
        openPanelOnActionClick: false,
      })
      await chrome.sidePanel.setOptions({ path: SIDEPANEL_PATH, enabled: true })
    } catch (error) {
      console.warn('[brosdk-assistant] failed to configure side panel', error)
    }
  }

  function openConfiguredSidePanel(tab: chrome.tabs.Tab) {
    const settings = cachedSettings
    if (!settings.open_side_panel_on_action_click) return

    if (settings.side_panel_per_window) {
      if (typeof tab.windowId !== 'number') return
      void chrome.sidePanel.open({ windowId: tab.windowId }).catch((error) => {
        console.warn('[brosdk-assistant] failed to open side panel', error)
      })
      return
    }

    if (typeof tab.id !== 'number') return
    void chrome.sidePanel.open({ tabId: tab.id }).catch((error) => {
      console.warn('[brosdk-assistant] failed to open side panel', error)
    })
  }

  function connectNative() {
    if (nativePort) return

    try {
      nativePort = chrome.runtime.connectNative(HOST_NAME)
      connected = true
      lastError = undefined
    } catch (error) {
      nativePort = null
      connected = false
      lastError = error instanceof Error ? error.message : String(error)
      return
    }

    nativePort.onMessage.addListener((message: NativeResponse | NativeEvent) => {
      if ('id' in message) {
        const waiter = pending.get(message.id)
        if (!waiter) return
        pending.delete(message.id)
        clearTimeout(waiter.timeoutId)
        if (message.error) {
          waiter.reject(new Error(message.error.message))
        } else {
          waiter.resolve(message.result)
        }
        return
      }

      if (message.event === 'extension.tool.request') {
        void handleExtensionToolRequest(message.payload)
        return
      }

      if (message.event === 'native.ready') {
        void syncSettingsFromNative()
      }
      void chrome.runtime.sendMessage({ type: 'native.event', event: message }).catch(() => undefined)
    })

    nativePort.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message || 'Native host disconnected'
      nativePort = null
      connected = false
      lastError = error
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timeoutId)
        waiter.reject(new Error(error))
      }
      pending.clear()
    })
  }

  function requestNative(request: NativeRequest) {
    connectNative()
    if (!nativePort) {
      return Promise.reject(new Error(lastError || 'Native host is not connected'))
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pending.delete(request.id)
        reject(new Error(`Native request timed out: ${request.method}`))
      }, NATIVE_REQUEST_TIMEOUT_MS)
      pending.set(request.id, { resolve, reject, timeoutId })
      try {
        nativePort?.postMessage(request)
      } catch (error) {
        clearTimeout(timeoutId)
        pending.delete(request.id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  function createNativeRequest(method: string, params?: unknown): NativeRequest {
    return {
      id: `bg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      method,
      params,
    }
  }

  async function syncSettingsFromNative() {
    try {
      const settings = normalizeSettings(
        (await requestNative(createNativeRequest('settings.get'))) as Partial<SettingsResult>,
      )
      await configureSidePanel(settings)
      void chrome.runtime.sendMessage({ type: 'settings.changed', settings }).catch(() => undefined)
    } catch (error) {
      console.warn('[brosdk-assistant] failed to sync native settings', error)
    }
  }

  function status(): NativeStatus {
    return { connected, lastError }
  }

  async function handleExtensionToolRequest(payload: unknown) {
    const request = payload as { id?: string; name?: string; arguments?: unknown }
    if (!request.id || !request.name) return

    try {
      const result = await callExtensionBrowserTool(request.name, request.arguments)
      nativePort?.postMessage({ id: request.id, result })
    } catch (error) {
      nativePort?.postMessage({
        id: request.id,
        error: {
          code: 'extension_tool_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  async function callExtensionBrowserTool(name: string, args: unknown) {
    const params = isRecord(args) ? args : {}
    switch (name) {
      case 'browser_tabs':
        return { tabs: (await chrome.tabs.query({})).map(tabSummary) }
      case 'browser_active_tab':
        return { tab: tabSummary(await resolveTargetTab(params)) }
      case 'browser_read_page':
        return readPage(params)
      case 'browser_snapshot':
        return snapshotPage(params)
      case 'browser_extract_links':
        return extractLinks(params)
      case 'browser_navigate':
        return navigateTab(params)
      case 'browser_click':
        return clickPage(params)
      case 'browser_type':
        return typeIntoPage(params)
      default:
        throw new Error(`Unknown extension browser tool: ${name}`)
    }
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
  }

  function numberParam(params: Record<string, unknown>, key: string) {
    const value = params[key]
    return typeof value === 'number' && Number.isInteger(value) ? value : undefined
  }

  function stringParam(params: Record<string, unknown>, key: string) {
    const value = params[key]
    return typeof value === 'string' ? value : undefined
  }

  function unwrapBrowserDomToolResult<T>(result: BrowserDomToolResult<T> | null | undefined) {
    if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
      throw new Error('Browser DOM tool returned an invalid result')
    }
    if (!result.ok) throw new Error(result.error)
    return result.value
  }

  function tabSummary(tab: chrome.tabs.Tab) {
    return {
      tabId: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      active: tab.active,
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl,
    }
  }

  async function resolveTargetTab(params: Record<string, unknown>) {
    const tabId = numberParam(params, 'tabId')
    if (typeof tabId === 'number') {
      return chrome.tabs.get(tabId)
    }

    const currentWindowTabs = await chrome.tabs.query({ active: true, currentWindow: true })
    if (currentWindowTabs[0]) return currentWindowTabs[0]

    const lastFocusedTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (lastFocusedTabs[0]) return lastFocusedTabs[0]

    throw new Error('No active tab found')
  }

  async function executeInTab<T>(
    params: Record<string, unknown>,
    func: (...args: unknown[]) => T,
    args: unknown[] = [],
    documentId?: string,
  ) {
    const tab = await resolveTargetTab(params)
    return executeInResolvedTab(tab, func, args, documentId)
  }

  async function executeInResolvedTab<T>(
    tab: chrome.tabs.Tab,
    func: (...args: unknown[]) => T,
    args: unknown[] = [],
    documentId?: string,
  ) {
    if (typeof tab.id !== 'number') throw new Error('Target tab has no tabId')
    const target: chrome.scripting.InjectionTarget = { tabId: tab.id }
    if (documentId) target.documentIds = [documentId]
    const results = await chrome.scripting.executeScript({
      target,
      func,
      args,
    })
    const result = results.find((entry) => entry.frameId === 0) ?? results[0]
    if (!result) throw new Error('Browser script returned no result')
    if (result.result === undefined) throw new Error('Browser script returned an empty result')
    return {
      tab: tabSummary(tab),
      documentId: result.documentId,
      result: result.result as T,
    }
  }

  async function executeBrowserDomTool<T = unknown>(
    params: Record<string, unknown>,
    action: string,
    payload: Record<string, unknown>,
  ) {
    const execution = await executeInTab<BrowserDomToolResult<T>>(
      params,
      browserDomTool as (...args: unknown[]) => BrowserDomToolResult<T>,
      [action, payload],
    )
    return { ...execution, result: unwrapBrowserDomToolResult(execution.result) }
  }

  async function readPage(params: Record<string, unknown>) {
    const maxChars = Math.min(Math.max(numberParam(params, 'maxChars') ?? 12000, 1000), 50000)
    return executeBrowserDomTool(params, 'readPage', { maxChars })
  }

  async function snapshotPage(params: Record<string, unknown>) {
    const maxElements = Math.min(Math.max(numberParam(params, 'maxElements') ?? 120, 10), 500)
    const execution = await executeBrowserDomTool<DomSnapshotResult>(params, 'snapshot', {
      maxElements,
    })
    const tabId = execution.tab.tabId
    if (typeof tabId !== 'number') throw new Error('Snapshot tab has no tabId')
    const revision = ++snapshotRevision
    const refs = new Map<string, SnapshotRefTarget>()
    const elements = execution.result.elements.map((element, index) => {
      const ref = `t${tabId}-r${revision}-e${index + 1}`
      refs.set(ref, {
        selector: element.selector,
        tag: element.tag,
        role: element.role,
        name: element.name,
      })
      return { ...element, ref }
    })
    snapshotsByTab.set(tabId, {
      documentId: execution.documentId,
      revision,
      refs,
    })
    return {
      ...execution,
      result: {
        ...execution.result,
        revision,
        elements,
      },
    }
  }

  async function extractLinks(params: Record<string, unknown>) {
    const maxLinks = Math.min(Math.max(numberParam(params, 'maxLinks') ?? 80, 1), 300)
    return executeBrowserDomTool(params, 'extractLinks', { maxLinks })
  }

  function createNavigationWaiter(tabId: number, timeoutMs: number) {
    const startedAt = Date.now()
    let settled = false
    let sawNavigation = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let resolveWait!: (result: NavigationWaitResult) => void
    const promise = new Promise<NavigationWaitResult>((resolve) => {
      resolveWait = resolve
    })

    function cleanup() {
      if (timeoutId) clearTimeout(timeoutId)
      chrome.tabs.onUpdated.removeListener(handleUpdated)
      chrome.tabs.onRemoved.removeListener(handleRemoved)
    }

    function finish(status: NavigationWaitResult['status'], tab?: chrome.tabs.Tab) {
      if (settled) return
      settled = true
      cleanup()
      resolveWait({ status, tab, elapsedMs: Date.now() - startedAt })
    }

    function handleUpdated(updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) {
      if (updatedTabId !== tabId) return
      if (changeInfo.status === 'loading' || changeInfo.url) sawNavigation = true
      if (sawNavigation && changeInfo.status === 'complete') finish('complete', tab)
    }

    function handleRemoved(removedTabId: number) {
      if (removedTabId === tabId) finish('closed')
    }

    chrome.tabs.onUpdated.addListener(handleUpdated)
    chrome.tabs.onRemoved.addListener(handleRemoved)
    timeoutId = setTimeout(() => finish('timeout'), timeoutMs)

    return {
      promise,
      complete(tab: chrome.tabs.Tab) {
        finish('complete', tab)
      },
      cancel() {
        if (settled) return
        settled = true
        cleanup()
      },
    }
  }

  async function navigateTab(params: Record<string, unknown>) {
    const url = stringParam(params, 'url')
    if (!url) throw new Error('url is required')
    const timeoutMs = Math.min(
      Math.max(numberParam(params, 'timeoutMs') ?? DEFAULT_NAVIGATION_TIMEOUT_MS, 100),
      MAX_NAVIGATION_TIMEOUT_MS,
    )
    const tab = await resolveTargetTab(params)
    if (typeof tab.id !== 'number') throw new Error('Target tab has no tabId')
    const waiter = createNavigationWaiter(tab.id, timeoutMs)
    try {
      const updated = await chrome.tabs.update(tab.id, { url })
      snapshotsByTab.delete(tab.id)
      if (updated.status === 'complete') waiter.complete(updated)
      const navigation = await waiter.promise
      const finalTab = navigation.tab ?? (await chrome.tabs.get(tab.id).catch(() => updated))
      return {
        tab: tabSummary(finalTab),
        navigation: {
          requestedUrl: url,
          finalUrl: finalTab.url,
          status: navigation.status,
          elapsedMs: navigation.elapsedMs,
          timeoutMs,
        },
      }
    } catch (error) {
      waiter.cancel()
      throw error
    }
  }

  async function executeSnapshotRef(
    params: Record<string, unknown>,
    action: 'click' | 'type',
    ref: string,
    payload: Record<string, unknown>,
  ) {
    const tab = await resolveTargetTab(params)
    if (typeof tab.id !== 'number') throw new Error('Target tab has no tabId')
    const snapshot = snapshotsByTab.get(tab.id)
    const target = snapshot?.refs.get(ref)
    if (!snapshot) {
      throw new Error(
        `Snapshot ref ${ref} is expired or does not belong to tab ${tab.id}. ` +
          'Call browser_snapshot again for the target tab.',
      )
    }
    if (!target) {
      throw new Error(
        `Snapshot ref ${ref} is not from the latest snapshot revision ` +
          `${snapshot.revision} for tab ${tab.id}. Call browser_snapshot again.`,
      )
    }
    let execution
    try {
      execution = await executeInResolvedTab<BrowserDomToolResult<unknown>>(
        tab,
        browserDomTool as (...args: unknown[]) => BrowserDomToolResult<unknown>,
        [
          action,
          {
            ...payload,
            ref,
            selector: target.selector,
            expectedTag: target.tag,
            expectedRole: target.role,
            expectedName: target.name,
          },
        ],
        snapshot.documentId,
      )
    } catch {
      snapshotsByTab.delete(tab.id)
      throw new Error(
        `Snapshot ref ${ref} expired because the page or target element changed. ` +
          'Call browser_snapshot again for the target tab.',
      )
    }
    const result = execution.result
    if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
      snapshotsByTab.delete(tab.id)
      throw new Error(
        `Snapshot ref ${ref} returned an invalid page result. ` +
          'Call browser_snapshot again for the target tab.',
      )
    }
    if (!result.ok) {
      if (/^(Snapshot target|Target element not found)/.test(result.error)) {
        snapshotsByTab.delete(tab.id)
        throw new Error(
          `Snapshot ref ${ref} expired because the page or target element changed. ` +
            'Call browser_snapshot again for the target tab.',
        )
      }
      throw new Error(result.error)
    }
    return { ...execution, result: result.value }
  }

  async function clickPage(params: Record<string, unknown>) {
    const ref = stringParam(params, 'ref')
    const selector = stringParam(params, 'selector')
    const text = stringParam(params, 'text')
    if (!ref && !selector && !text) throw new Error('ref, selector, or text is required')
    if (ref) return executeSnapshotRef(params, 'click', ref, {})
    return executeBrowserDomTool(params, 'click', { selector, text })
  }

  async function typeIntoPage(params: Record<string, unknown>) {
    const ref = stringParam(params, 'ref')
    const selector = stringParam(params, 'selector')
    const text = stringParam(params, 'text')
    if (!ref && !selector) throw new Error('ref or selector is required')
    if (text === undefined) throw new Error('text is required')
    if (ref) return executeSnapshotRef(params, 'type', ref, { text })
    return executeBrowserDomTool(params, 'type', { selector, text })
  }

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading' || changeInfo.url) snapshotsByTab.delete(tabId)
  })

  chrome.tabs.onRemoved.addListener((tabId) => {
    snapshotsByTab.delete(tabId)
  })

  chrome.runtime.onInstalled.addListener(() => {
    void chrome.storage.local.remove(LEGACY_SETTINGS_STORAGE_KEY)
    void configureSidePanel()
  })

  chrome.runtime.onStartup.addListener(() => {
    void chrome.storage.local.remove(LEGACY_SETTINGS_STORAGE_KEY)
    void configureSidePanel()
  })

  chrome.action.onClicked.addListener((tab) => {
    openConfiguredSidePanel(tab)
  })

  chrome.runtime.onMessage.addListener((message: BackgroundRequest, sender, sendResponse) => {
    if (message?.type === 'native.status') {
      sendResponse({ ok: true, data: status() } satisfies BackgroundResponse<NativeStatus>)
      return false
    }

    if (message?.type === 'native.request') {
      requestNative(message.request)
        .then((data) => {
          sendResponse({ ok: true, data } satisfies BackgroundResponse)
        })
        .catch((error: Error) => {
          sendResponse({ ok: false, error: error.message } satisfies BackgroundResponse)
        })
      return true
    }

    if (message?.type === 'settings.changed') {
      void configureSidePanel(message.settings)
      sendResponse({ ok: true } satisfies BackgroundResponse)
      return false
    }

    if (import.meta.env.MODE === 'test' && message?.type === 'extension.tool.invoke') {
      if (sender.id !== chrome.runtime.id) {
        sendResponse({
          ok: false,
          error: 'Extension tool requests must be internal',
        } satisfies BackgroundResponse)
        return false
      }
      callExtensionBrowserTool(message.name, message.arguments)
        .then((data) => {
          sendResponse({ ok: true, data } satisfies BackgroundResponse)
        })
        .catch((error: Error) => {
          sendResponse({ ok: false, error: error.message } satisfies BackgroundResponse)
        })
      return true
    }

    return false
  })

  void chrome.storage.local.remove(LEGACY_SETTINGS_STORAGE_KEY)
  void configureSidePanel()
})

function browserDomTool(actionInput: unknown, payloadInput: unknown) {
  type SnapshotElement = {
    role: string
    name: string
    tag: string
    text: string
    selector: string
    href?: string
    value?: string
    placeholder?: string
    visible: boolean
  }

  const action = typeof actionInput === 'string' ? actionInput : ''
  const payload =
    payloadInput && typeof payloadInput === 'object' && !Array.isArray(payloadInput)
      ? (payloadInput as Record<string, unknown>)
      : {}

  function numberValue(key: string, fallback: number, min: number, max: number) {
    const value = payload[key]
    const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback
    return Math.max(min, Math.min(max, Math.floor(numeric)))
  }

  function stringValue(key: string) {
    const value = payload[key]
    return typeof value === 'string' && value.trim() ? value : undefined
  }

  function rawStringValue(key: string) {
    const value = payload[key]
    return typeof value === 'string' ? value : undefined
  }

  function visibleText(element: Element) {
    return (element.textContent || '').replace(/\s+/g, ' ').trim()
  }

  function isVisible(element: HTMLElement) {
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false
    }
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  function inferRole(element: HTMLElement) {
    const explicitRole = element.getAttribute('role')
    if (explicitRole) return explicitRole
    const tag = element.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'select') return 'combobox'
    if (tag === 'summary') return 'button'
    if (tag === 'input') {
      const type = (element as HTMLInputElement).type
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
      return 'textbox'
    }
    return element.hasAttribute('onclick') ? 'button' : 'element'
  }

  function accessibleName(element: HTMLElement) {
    const labelledBy = element.getAttribute('aria-labelledby')
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (text) return text
    }
    const aria = element.getAttribute('aria-label')?.trim()
    if (aria) return aria
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.labels?.[0]?.textContent) return element.labels[0].textContent.trim()
      if (element.placeholder) return element.placeholder
      if (element.value && ['button', 'submit', 'reset'].includes(element.type)) {
        return element.value
      }
    }
    return visibleText(element)
  }

  function cssEscape(value: string) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value)
    return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
  }

  function cssSelector(element: HTMLElement) {
    if (element.id && !/^\d/.test(element.id)) return `#${cssEscape(element.id)}`
    const parts: string[] = []
    let current: Element | null = element
    while (current && current instanceof HTMLElement && current !== document.body) {
      let part = current.tagName.toLowerCase()
      if (current.classList.length > 0) {
        part += `.${Array.from(current.classList).slice(0, 2).map(cssEscape).join('.')}`
      }
      const parent = current.parentElement
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (sibling) => sibling.tagName === current?.tagName,
        )
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`
      }
      parts.unshift(part)
      current = current.parentElement
      if (parts.length >= 5) break
    }
    return parts.join(' > ')
  }

  function snapshot(maxElements: number) {
    const candidates = Array.from(
      document.querySelectorAll(
        [
          'a[href]',
          'button',
          'input',
          'textarea',
          'select',
          'summary',
          '[role]',
          '[onclick]',
          '[contenteditable="true"]',
          '[tabindex]:not([tabindex="-1"])',
        ].join(','),
      ),
    )
    const elements: SnapshotElement[] = []
    for (const element of candidates) {
      if (!(element instanceof HTMLElement)) continue
      const visible = isVisible(element)
      const role = inferRole(element)
      const name = accessibleName(element)
      const text = visibleText(element)
      if (!visible && !name && !text) continue
      elements.push({
        role,
        name,
        tag: element.tagName.toLowerCase(),
        text,
        selector: cssSelector(element),
        href: element instanceof HTMLAnchorElement ? element.href : undefined,
        value:
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? element.value
            : undefined,
        placeholder:
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? element.placeholder
            : undefined,
        visible,
      })
      if (elements.length >= maxElements) break
    }
    return {
      title: document.title,
      url: location.href,
      elements,
      truncated: candidates.length > elements.length,
    }
  }

  function findElement(target: { selector?: string; text?: string }) {
    if (target.selector) return document.querySelector(target.selector)
    if (target.text) {
      const needle = target.text.toLowerCase()
      return Array.from(
        document.querySelectorAll('button,a,input,[role="button"],[onclick],summary'),
      ).find((candidate) => visibleText(candidate).toLowerCase().includes(needle))
    }
    return null
  }

  function assertSnapshotTarget(element: HTMLElement) {
    const expectedTag = stringValue('expectedTag')
    const expectedRole = stringValue('expectedRole')
    const expectedName = stringValue('expectedName')
    if (expectedTag && element.tagName.toLowerCase() !== expectedTag) {
      throw new Error('Snapshot target tag changed')
    }
    if (expectedRole && inferRole(element) !== expectedRole) {
      throw new Error('Snapshot target role changed')
    }
    if (expectedName && accessibleName(element) !== expectedName) {
      throw new Error('Snapshot target accessible name changed')
    }
  }

  function setNativeTextValue(element: HTMLInputElement | HTMLTextAreaElement, text: string) {
    if (
      element instanceof HTMLInputElement &&
      ['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(
        element.type,
      )
    ) {
      throw new Error(`Input type ${element.type} does not accept browser_type text`)
    }
    const prototype =
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
    if (!descriptor?.set) throw new Error('Native text value setter is unavailable')

    const previousValueLength = element.value.length
    element.focus()
    try {
      element.select()
    } catch {
      // Some input types do not support text selection.
    }
    const inputType = 'insertReplacementText'
    const beforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: text,
      inputType,
    })
    if (!element.dispatchEvent(beforeInput)) throw new Error('Text input was cancelled by the page')
    descriptor.set.call(element, text)
    element.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: text,
        inputType,
      }),
    )
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return {
      controlType:
        element instanceof HTMLTextAreaElement ? 'textarea' : `input:${element.type || 'text'}`,
      inputEventType: inputType,
      previousValueLength,
      valueLength: element.value.length,
      focused: document.activeElement === element,
      valueSetter: 'native-prototype',
      events: ['beforeinput', 'input', 'change'],
    }
  }

  try {
    if (action === 'readPage') {
      const maxChars = numberValue('maxChars', 12000, 1000, 50000)
      const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim()
      return {
        ok: true,
        value: {
          title: document.title,
          url: location.href,
          text: text.slice(0, maxChars),
          truncated: text.length > maxChars,
        },
      }
    }

    if (action === 'snapshot') {
      return { ok: true, value: snapshot(numberValue('maxElements', 120, 10, 500)) }
    }

    if (action === 'extractLinks') {
      const maxLinks = numberValue('maxLinks', 80, 1, 300)
      const links = Array.from(document.querySelectorAll('a[href]'))
        .map((anchor) => {
          const link = anchor as HTMLAnchorElement
          return {
            text: (link.innerText || link.getAttribute('aria-label') || '').trim(),
            href: link.href,
          }
        })
        .filter((link) => link.href)
        .slice(0, maxLinks)
      return { ok: true, value: { title: document.title, url: location.href, links } }
    }

    if (action === 'click') {
      const ref = stringValue('ref')
      const selector = stringValue('selector')
      const text = stringValue('text')
      const element = findElement({ selector, text })
      if (!(element instanceof HTMLElement)) throw new Error('Target element not found')
      assertSnapshotTarget(element)
      const target = {
        tag: element.tagName.toLowerCase(),
        role: inferRole(element),
        name: accessibleName(element),
      }
      element.scrollIntoView({ block: 'center', inline: 'center' })
      element.click()
      return {
        ok: true,
        value: {
          clicked: true,
          ref,
          selector,
          text: visibleText(element),
          tag: element.tagName.toLowerCase(),
          diagnostics: {
            source: ref ? 'snapshot-ref' : selector ? 'selector' : 'visible-text',
            target,
          },
        },
      }
    }

    if (action === 'type') {
      const ref = stringValue('ref')
      const selector = stringValue('selector')
      const text = rawStringValue('text')
      const element = findElement({ selector })
      if (!(element instanceof HTMLElement)) throw new Error('Target element not found')
      assertSnapshotTarget(element)
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
        throw new Error('Target is not a text input or textarea')
      }
      const target = {
        tag: element.tagName.toLowerCase(),
        role: inferRole(element),
        name: accessibleName(element),
      }
      const diagnostics = setNativeTextValue(element, text ?? '')
      return {
        ok: true,
        value: {
          typed: true,
          ref,
          selector,
          diagnostics: {
            source: ref ? 'snapshot-ref' : 'selector',
            target,
            ...diagnostics,
          },
        },
      }
    }

    throw new Error(`Unknown browser DOM action: ${action}`)
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
