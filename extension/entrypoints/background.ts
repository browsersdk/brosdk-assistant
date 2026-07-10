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

export default defineBackground(() => {
  let nativePort: chrome.runtime.Port | null = null
  let connected = false
  let lastError: string | undefined
  let cachedSettings: SettingsResult = DEFAULT_SETTINGS
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
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

      void syncSettingsFromNative()
      void chrome.runtime.sendMessage({ type: 'native.event', event: message }).catch(() => undefined)
    })

    nativePort.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message || 'Native host disconnected'
      nativePort = null
      connected = false
      lastError = error
      for (const waiter of pending.values()) {
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
      pending.set(request.id, { resolve, reject })
      nativePort?.postMessage(request)
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
  ) {
    const tab = await resolveTargetTab(params)
    if (typeof tab.id !== 'number') throw new Error('Target tab has no tabId')
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func,
      args,
    })
    return {
      tab: tabSummary(tab),
      result: result?.result,
    }
  }

  async function executeBrowserDomTool(
    params: Record<string, unknown>,
    action: string,
    payload: Record<string, unknown>,
  ) {
    return executeInTab(params, browserDomTool, [action, payload])
  }

  async function readPage(params: Record<string, unknown>) {
    const maxChars = Math.min(Math.max(numberParam(params, 'maxChars') ?? 12000, 1000), 50000)
    return executeBrowserDomTool(params, 'readPage', { maxChars })
  }

  async function snapshotPage(params: Record<string, unknown>) {
    const maxElements = Math.min(Math.max(numberParam(params, 'maxElements') ?? 120, 10), 500)
    return executeBrowserDomTool(params, 'snapshot', { maxElements })
  }

  async function extractLinks(params: Record<string, unknown>) {
    const maxLinks = Math.min(Math.max(numberParam(params, 'maxLinks') ?? 80, 1), 300)
    return executeBrowserDomTool(params, 'extractLinks', { maxLinks })
  }

  async function navigateTab(params: Record<string, unknown>) {
    const url = stringParam(params, 'url')
    if (!url) throw new Error('url is required')
    const tab = await resolveTargetTab(params)
    if (typeof tab.id !== 'number') throw new Error('Target tab has no tabId')
    const updated = await chrome.tabs.update(tab.id, { url })
    return { tab: tabSummary(updated) }
  }

  async function clickPage(params: Record<string, unknown>) {
    const ref = stringParam(params, 'ref')
    const selector = stringParam(params, 'selector')
    const text = stringParam(params, 'text')
    if (!ref && !selector && !text) throw new Error('ref, selector, or text is required')
    return executeBrowserDomTool(params, 'click', { ref, selector, text })
  }

  async function typeIntoPage(params: Record<string, unknown>) {
    const ref = stringParam(params, 'ref')
    const selector = stringParam(params, 'selector')
    const text = stringParam(params, 'text')
    if (!ref && !selector) throw new Error('ref or selector is required')
    if (text === undefined) throw new Error('text is required')
    return executeBrowserDomTool(params, 'type', { ref, selector, text })
  }

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

  chrome.runtime.onMessage.addListener((message: BackgroundRequest, _sender, sendResponse) => {
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

    return false
  })

  void chrome.storage.local.remove(LEGACY_SETTINGS_STORAGE_KEY)
  void configureSidePanel()
})

function browserDomTool(actionInput: unknown, payloadInput: unknown) {
  type SnapshotElement = {
    ref: string
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
        ref: `e${elements.length + 1}`,
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

  function findElement(target: { ref?: string; selector?: string; text?: string }) {
    if (target.selector) return document.querySelector(target.selector)
    if (target.ref) {
      const index = Number(target.ref.replace(/^e/, '')) - 1
      if (Number.isInteger(index) && index >= 0) {
        const entry = snapshot(500).elements[index]
        if (entry?.selector) {
          const element = document.querySelector(entry.selector)
          if (element) return element
        }
      }
    }
    if (target.text) {
      const needle = target.text.toLowerCase()
      return Array.from(
        document.querySelectorAll('button,a,input,[role="button"],[onclick],summary'),
      ).find((candidate) => visibleText(candidate).toLowerCase().includes(needle))
    }
    return null
  }

  if (action === 'readPage') {
    const maxChars = numberValue('maxChars', 12000, 1000, 50000)
    const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim()
    return {
      title: document.title,
      url: location.href,
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars,
    }
  }

  if (action === 'snapshot') {
    return snapshot(numberValue('maxElements', 120, 10, 500))
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
    return { title: document.title, url: location.href, links }
  }

  if (action === 'click') {
    const ref = stringValue('ref')
    const selector = stringValue('selector')
    const text = stringValue('text')
    const element = findElement({ ref, selector, text })
    if (!(element instanceof HTMLElement)) throw new Error('Target element not found')
    element.scrollIntoView({ block: 'center', inline: 'center' })
    element.click()
    return { clicked: true, ref, selector, text: visibleText(element), tag: element.tagName.toLowerCase() }
  }

  if (action === 'type') {
    const ref = stringValue('ref')
    const selector = stringValue('selector')
    const text = stringValue('text')
    const element = findElement({ ref, selector })
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      throw new Error('Target is not a text input or textarea')
    }
    element.focus()
    element.value = text ?? ''
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text ?? '' }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return { typed: true, ref, selector }
  }

  throw new Error(`Unknown browser DOM action: ${action}`)
}
