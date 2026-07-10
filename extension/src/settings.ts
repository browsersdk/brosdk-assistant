import type { BrowserToolsMode, ModelApiType, SettingsResult } from './types'

export const DEFAULT_SETTINGS: SettingsResult = {
  configured: false,
  workspace_dir: '.',
  default_workspace_dir: undefined,
  browser_tools_mode: 'mcp',
  mcp_url: 'http://127.0.0.1:3000/mcp',
  model_base_url: '',
  model_name: '',
  model_api_type: 'openai',
  api_key: '',
  temperature: 0,
  open_side_panel_on_action_click: true,
  side_panel_per_window: true,
}

export function isSettingsConfigured(settings: SettingsResult) {
  return hasRequiredSettings(settings)
}

function hasRequiredSettings(settings: Partial<SettingsResult>) {
  return Boolean(
    (settings.browser_tools_mode !== 'mcp' || settings.mcp_url?.trim()) &&
      settings.model_base_url?.trim() &&
      settings.model_name?.trim() &&
      settings.api_key?.trim(),
  )
}

export function normalizeModelApiType(value: string): ModelApiType {
  return value === 'anthropic' ? 'anthropic' : 'openai'
}

export function normalizeBrowserToolsMode(value?: string): BrowserToolsMode {
  if (value === 'extension' || value === 'off') return value
  return 'mcp'
}

export function normalizeSettings(settings?: Partial<SettingsResult> | null): SettingsResult {
  const workspaceDir = settings?.workspace_dir ?? DEFAULT_SETTINGS.workspace_dir
  const merged = {
    ...DEFAULT_SETTINGS,
    ...settings,
    workspace_dir: typeof workspaceDir === 'string' ? workspaceDir : DEFAULT_SETTINGS.workspace_dir,
    model_api_type: normalizeModelApiType(settings?.model_api_type ?? DEFAULT_SETTINGS.model_api_type),
    browser_tools_mode: normalizeBrowserToolsMode(settings?.browser_tools_mode),
    temperature: Number(settings?.temperature ?? DEFAULT_SETTINGS.temperature) || 0,
    open_side_panel_on_action_click:
      settings?.open_side_panel_on_action_click ?? DEFAULT_SETTINGS.open_side_panel_on_action_click,
    side_panel_per_window: settings?.side_panel_per_window ?? DEFAULT_SETTINGS.side_panel_per_window,
  }

  return {
    ...merged,
    configured: hasRequiredSettings(merged),
  }
}

export function formatModelApiType(value: ModelApiType) {
  return value === 'anthropic' ? 'Anthropic API' : 'OpenAI API'
}
