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
