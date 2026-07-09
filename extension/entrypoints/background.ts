import { defineBackground } from 'wxt/utils/define-background'
import type {
  BackgroundRequest,
  BackgroundResponse,
  NativeEvent,
  NativeRequest,
  NativeResponse,
  NativeStatus,
} from '../src/types'

const HOST_NAME = 'com.browsersdk.assistant'

export default defineBackground(() => {
  let nativePort: chrome.runtime.Port | null = null
  let connected = false
  let lastError: string | undefined
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
    }
  >()

  async function configureSidePanel() {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      await chrome.sidePanel.setOptions({ path: 'sidepanel.html' })
    } catch (error) {
      console.warn('[brosdk-assistant] failed to configure side panel', error)
    }
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

  function status(): NativeStatus {
    return { connected, lastError }
  }

  chrome.runtime.onInstalled.addListener(() => {
    void configureSidePanel()
  })

  chrome.runtime.onStartup.addListener(() => {
    void configureSidePanel()
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

    return false
  })

  void configureSidePanel()
})

