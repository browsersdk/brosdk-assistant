import type { BackgroundRequest, BackgroundResponse, NativeStatus } from './types'

export function createRequest(method: string, params?: unknown) {
  return {
    id: `ui-${Date.now()}-${crypto.randomUUID()}`,
    method,
    params,
  }
}

export async function callNative<T>(method: string, params?: unknown): Promise<T> {
  const response = await chrome.runtime.sendMessage<BackgroundRequest, BackgroundResponse<T>>({
    type: 'native.request',
    request: createRequest(method, params),
  })
  if (!response?.ok) {
    throw new Error(response?.error || 'Native request failed')
  }
  return response.data as T
}

export async function getNativeStatus(): Promise<NativeStatus> {
  const response = await chrome.runtime.sendMessage<BackgroundRequest, BackgroundResponse<NativeStatus>>({
    type: 'native.status',
  })
  if (!response?.ok || !response.data) {
    return { connected: false, lastError: response?.error || 'No status response' }
  }
  return response.data
}
