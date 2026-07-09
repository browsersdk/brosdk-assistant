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
import { DEFAULT_SETTINGS, loadStoredSettings, saveStoredSettings } from './settings'
import type { HealthResult, ModelApiType, SettingsResult } from './types'

type SaveState =
  | { kind: 'idle'; text: string }
  | { kind: 'checking'; text: string }
  | { kind: 'success'; text: string }
  | { kind: 'error'; text: string }

export function OptionsApp() {
  const [settings, setSettings] = useState<SettingsResult>(DEFAULT_SETTINGS)
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
      const nextSettings = await loadStoredSettings()
      setSettings(nextSettings)
      setDraftSettings(nextSettings)
    } catch (error) {
      setStatus({
        kind: 'error',
        text: `Failed to load configuration: ${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }

    try {
      const health = await callNative<HealthResult>('agent.health')
      setStatus({
        kind: 'success',
        text: `Configuration loaded. Native host ready: ${health.service} ${health.version}`,
      })
    } catch (error) {
      setStatus({
        kind: 'idle',
        text: `Configuration loaded. Native host not connected: ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
    }
  }

  async function saveSettings() {
    setStatus({ kind: 'checking', text: 'Saving configuration...' })
    let nextSettings: SettingsResult
    try {
      nextSettings = await saveStoredSettings(draftSettings)
      setSettings(nextSettings)
      setDraftSettings(nextSettings)
    } catch (error) {
      setStatus({
        kind: 'error',
        text: `Save failed: ${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }

    try {
      await callNative<SettingsResult>('settings.set', nextSettings)
      setStatus({
        kind: 'success',
        text: `Configuration saved. Native host synced for ${nextSettings.model_name}`,
      })
    } catch (error) {
      setStatus({
        kind: 'success',
        text: `Configuration saved. Native host not connected: ${
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
            <p>These settings are saved in the extension and used by the side panel.</p>
          </div>
        </div>

        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault()
            void saveSettings()
          }}
        >
          <label htmlFor="mcp-url">MCP URL</label>
          <input
            id="mcp-url"
            value={draftSettings.mcp_url}
            onChange={(event) => updateDraft('mcp_url', event.target.value)}
            placeholder={DEFAULT_SETTINGS.mcp_url}
            required
          />

          <label htmlFor="model-api-type">API Type</label>
          <select
            id="model-api-type"
            value={draftSettings.model_api_type}
            onChange={(event) => updateDraft('model_api_type', event.target.value as ModelApiType)}
          >
            <option value="openai">OpenAI API</option>
            <option value="anthropic">Anthropic API</option>
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
            placeholder="optional"
            type="password"
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
            placeholder="."
          />

          <div className="settings-actions">
            <button className="configure-button" type="submit" disabled={saving}>
              <Save size={15} />
              Save
            </button>
          </div>
        </form>
      </section>
    </main>
  )
}
