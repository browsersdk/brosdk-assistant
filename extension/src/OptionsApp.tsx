import {
  CircleAlert,
  CircleCheck,
  CircleDot,
  RefreshCw,
  Save,
  Settings,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { callNative } from './nativeClient'
import { DEFAULT_SETTINGS, normalizeSettings } from './settings'
import type { BrowserToolsMode, HealthResult, ModelApiType, SettingsResult } from './types'

type SaveState =
  | { kind: 'idle'; text: string }
  | { kind: 'checking'; text: string }
  | { kind: 'success'; text: string }
  | { kind: 'error'; text: string }

export function OptionsApp() {
  const [draftSettings, setDraftSettings] = useState<SettingsResult>(DEFAULT_SETTINGS)
  const [status, setStatus] = useState<SaveState>({
    kind: 'idle',
    text: 'Loading configuration...',
  })

  const statusIcon = useMemo(() => {
    if (status.kind === 'success') return <CircleCheck size={16} />
    if (status.kind === 'error') return <CircleAlert size={16} />
    return <CircleDot size={16} />
  }, [status.kind])

  useEffect(() => {
    void loadSettings()
  }, [])

  async function loadSettings() {
    setStatus({ kind: 'checking', text: 'Loading configuration...' })
    try {
      const health = await callNative<HealthResult>('agent.health')
      const syncedSettings = normalizeSettings(await callNative<SettingsResult>('settings.get'))
      setDraftSettings(syncedSettings)
      setStatus(
        syncedSettings.model_api_type === 'anthropic'
          ? {
              kind: 'error',
              text: 'Anthropic API is not supported yet. Select OpenAI API before saving.',
            }
          : {
              kind: 'success',
              text: `Configuration loaded. Native host ready: ${health.service} ${health.version}`,
            },
      )
    } catch (error) {
      setStatus({
        kind: 'error',
        text: `Native host not connected. Configuration is stored in native host only: ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
    }
  }

  async function saveSettings() {
    setStatus({ kind: 'checking', text: 'Saving configuration...' })
    try {
      const nextSettings = normalizeSettings(await callNative<SettingsResult>('settings.set', draftSettings))
      setDraftSettings(nextSettings)
      await chrome.runtime
        .sendMessage({ type: 'settings.changed', settings: nextSettings })
        .catch(() => undefined)
      setStatus({
        kind: 'success',
        text: `Configuration saved. Native host synced for ${nextSettings.model_name}`,
      })
    } catch (error) {
      setStatus({
        kind: 'error',
        text: `Save failed. Native host is required: ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
    }
  }

  function updateDraft<K extends keyof SettingsResult>(key: K, value: SettingsResult[K]) {
    setDraftSettings((current) => ({
      ...current,
      [key]: value,
    }))
  }

  const saving = status.kind === 'checking'
  const providerUnavailable = draftSettings.model_api_type !== 'openai'
  const modelBaseUrlPlaceholder =
    draftSettings.model_api_type === 'anthropic'
      ? 'https://api.anthropic.com'
      : 'https://api.openai.com/v1'
  const modelNamePlaceholder =
    draftSettings.model_api_type === 'anthropic' ? 'claude-model-name' : 'openai-model-name'

  return (
    <main className="options-shell">
      <header className="options-header">
        <div className="brand options-brand">
          <span className="brand-mark">
            <img src="/icons/message-bot.svg" alt="" />
          </span>
          <div>
            <h1>Brosdk Assistant</h1>
            <p>Plugin options</p>
          </div>
        </div>
        <button
          className="icon-button"
          type="button"
          title="Reload configuration"
          onClick={() => void loadSettings()}
        >
          <RefreshCw size={16} />
        </button>
      </header>

      <section className={`status-strip ${status.kind}`}>
        {statusIcon}
        <span>{status.text}</span>
      </section>

      <section className="options-panel">
        <div className="options-panel-header">
          <Settings size={18} />
          <div>
            <h2>Assistant Configuration</h2>
            <p>These settings are saved by the native host and synced to the side panel.</p>
          </div>
        </div>

        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault()
            void saveSettings()
          }}
        >
          <label htmlFor="browser-tools-mode">Browser Tools Source</label>
          <select
            id="browser-tools-mode"
            value={draftSettings.browser_tools_mode}
            onChange={(event) =>
              updateDraft('browser_tools_mode', event.target.value as BrowserToolsMode)
            }
          >
            <option value="mcp">MCP Server</option>
            <option value="extension">Chrome Extension</option>
            <option value="off">Off</option>
          </select>

          {draftSettings.browser_tools_mode === 'mcp' && (
            <>
              <label htmlFor="mcp-url">MCP URL</label>
              <input
                id="mcp-url"
                value={draftSettings.mcp_url}
                onChange={(event) => updateDraft('mcp_url', event.target.value)}
                placeholder={DEFAULT_SETTINGS.mcp_url}
                required
              />
            </>
          )}

          <label htmlFor="model-api-type">API Type</label>
          <select
            id="model-api-type"
            value={draftSettings.model_api_type}
            onChange={(event) => updateDraft('model_api_type', event.target.value as ModelApiType)}
          >
            <option value="openai">OpenAI API</option>
            <option value="anthropic" disabled>
              Anthropic API (planned)
            </option>
          </select>

          <label htmlFor="model-base-url">Base URL</label>
          <input
            id="model-base-url"
            value={draftSettings.model_base_url}
            onChange={(event) => updateDraft('model_base_url', event.target.value)}
            placeholder={modelBaseUrlPlaceholder}
            required
          />

          <label htmlFor="model-name">Model Name</label>
          <input
            id="model-name"
            value={draftSettings.model_name}
            onChange={(event) => updateDraft('model_name', event.target.value)}
            placeholder={modelNamePlaceholder}
            required
          />

          <label htmlFor="api-key">API Key</label>
          <input
            id="api-key"
            value={draftSettings.api_key}
            onChange={(event) => updateDraft('api_key', event.target.value)}
            placeholder="sk-..."
            type="password"
            required
          />

          <label htmlFor="temperature">Temperature</label>
          <input
            id="temperature"
            value={draftSettings.temperature}
            onChange={(event) => updateDraft('temperature', Number(event.target.value) || 0)}
            min="0"
            max="2"
            step="0.1"
            type="number"
          />

          <label htmlFor="workspace-dir">Workspace Folder</label>
          <input
            id="workspace-dir"
            value={draftSettings.workspace_dir}
            onChange={(event) => updateDraft('workspace_dir', event.target.value)}
            placeholder={draftSettings.default_workspace_dir || 'Native default workspace'}
          />

          <div className="settings-section-title">Side Panel</div>
          <div className="settings-toggle-row">
            <div>
              <label htmlFor="open-side-panel-on-action">Open on Extension Click</label>
              <p>Open the assistant side panel when the toolbar icon is clicked.</p>
            </div>
            <input
              id="open-side-panel-on-action"
              checked={draftSettings.open_side_panel_on_action_click}
              onChange={(event) =>
                updateDraft('open_side_panel_on_action_click', event.target.checked)
              }
              type="checkbox"
            />
          </div>

          <div className="settings-toggle-row">
            <div>
              <label htmlFor="side-panel-per-window">Share Side Panel Across Tabs</label>
              <p>Use one side panel for the whole window instead of treating tabs separately.</p>
            </div>
            <input
              id="side-panel-per-window"
              checked={draftSettings.side_panel_per_window}
              onChange={(event) => updateDraft('side_panel_per_window', event.target.checked)}
              type="checkbox"
            />
          </div>

          <div className="settings-actions">
            <button
              className="configure-button"
              type="submit"
              disabled={saving || providerUnavailable}
            >
              <Save size={15} />
              Save
            </button>
          </div>
        </form>
      </section>
    </main>
  )
}
