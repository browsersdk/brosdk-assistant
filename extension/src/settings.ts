import type { ModelApiType, SettingsResult } from './types'

const SETTINGS_STORAGE_KEY = 'brosdk-assistant-settings'

export const DEFAULT_SETTINGS: SettingsResult = {
  configured: false,
  workspace_dir: '.',
  mcp_url: 'http://127.0.0.1:3000/mcp',
  model_base_url: '',
  model_name: '',
  model_api_type: 'openai',
  api_key: '',
  temperature: 0,
}

export function isSettingsConfigured(settings: SettingsResult) {
  return Boolean(settings.configured)
}

export function normalizeModelApiType(value: string): ModelApiType {
  return value === 'anthropic' ? 'anthropic' : 'openai'
}

export function normalizeSettings(settings?: Partial<SettingsResult> | null): SettingsResult {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    configured: Boolean(settings?.configured),
    model_api_type: normalizeModelApiType(settings?.model_api_type ?? DEFAULT_SETTINGS.model_api_type),
    temperature: Number(settings?.temperature ?? DEFAULT_SETTINGS.temperature) || 0,
  }
}

export function formatModelApiType(value: ModelApiType) {
  return value === 'anthropic' ? 'Anthropic API' : 'OpenAI API'
}

export async function loadStoredSettings(): Promise<SettingsResult> {
  const result = await chrome.storage.local.get(SETTINGS_STORAGE_KEY)
  return normalizeSettings(result[SETTINGS_STORAGE_KEY] as Partial<SettingsResult> | undefined)
}

export async function saveStoredSettings(settings: SettingsResult): Promise<SettingsResult> {
  const nextSettings = normalizeSettings({
    ...settings,
    configured: true,
  })
  await chrome.storage.local.set({
    [SETTINGS_STORAGE_KEY]: nextSettings,
  })
  return nextSettings
}
