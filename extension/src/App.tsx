import {
  Bot,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Eraser,
  RefreshCw,
  Save,
  Send,
  Settings,
  Square,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { callNative, getNativeStatus } from './nativeClient'
import type {
  ChatMessage,
  EchoResult,
  HealthResult,
  ModelApiType,
  NativeStatus,
  SettingsResult,
} from './types'

type HealthState =
  | { kind: 'checking'; text: string }
  | { kind: 'online'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'idle'; text: string }

const DEFAULT_SETTINGS: SettingsResult = {
  workspace_dir: '',
  mcp_url: 'http://127.0.0.1:3000/mcp',
  model_base_url: 'https://api.deepseek.com',
  model_name: 'deepseek-v4-flash',
  model_api_type: 'openai-compatible',
  api_key: '',
  temperature: 0,
}

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function shortPath(path: string) {
  const normalized = path.replaceAll('\\', '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 2) return path
  return `.../${parts.slice(-2).join('/')}`
}

export function App() {
  const [nativeStatus, setNativeStatus] = useState<NativeStatus>({ connected: false })
  const [health, setHealth] = useState<HealthState>({
    kind: 'idle',
    text: 'Native host not checked',
  })
  const [settings, setSettings] = useState<SettingsResult>(DEFAULT_SETTINGS)
  const [draftSettings, setDraftSettings] = useState<SettingsResult>(DEFAULT_SETTINGS)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const messagesRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const canSend = prompt.trim().length > 0 && !busy

  const statusIcon = useMemo(() => {
    if (health.kind === 'online') return <CircleCheck size={16} />
    if (health.kind === 'error') return <CircleAlert size={16} />
    return <CircleDot size={16} />
  }, [health.kind])

  useEffect(() => {
    void checkNative()
  }, [])

  useEffect(() => {
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [messages])

  async function checkNative() {
    setHealth({ kind: 'checking', text: 'Checking native host...' })
    try {
      const result = await callNative<HealthResult>('agent.health')
      const nextSettings = await callNative<SettingsResult>('settings.get')
      const status = await getNativeStatus()
      setNativeStatus(status)
      setSettings(nextSettings)
      setDraftSettings(nextSettings)
      setHealth({
        kind: 'online',
        text: `${result.service} ${result.version} · pid ${result.pid}`,
      })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setNativeStatus({ connected: false, lastError: text })
      setHealth({ kind: 'error', text })
    }
  }

  async function saveSettings() {
    setHealth({ kind: 'checking', text: 'Saving settings...' })
    try {
      const nextSettings = await callNative<SettingsResult>('settings.set', draftSettings)
      setSettings(nextSettings)
      setDraftSettings(nextSettings)
      setHealth({
        kind: 'online',
        text: `Settings saved · ${nextSettings.model_name}`,
      })
    } catch (error) {
      setHealth({
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function startNewChat() {
    setMessages([])
    setPrompt('')
    setHealth({ kind: 'idle', text: 'Chat reset' })
    await callNative('agent.reset').catch(() => undefined)
    inputRef.current?.focus()
  }

  async function submitPrompt() {
    const raw = prompt.trim()
    if (!raw || busy) return

    setPrompt('')
    setBusy(true)
    setHealth({ kind: 'checking', text: 'Agent is working...' })
    setMessages((current) => [
      ...current,
      {
        id: createId(),
        role: 'user',
        content: raw,
        time: nowLabel(),
      },
    ])

    try {
      const result = await callNative<EchoResult>('agent.echo', {
        message: raw,
        settings,
      })
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: 'assistant',
          content: `Native host echo:\n${JSON.stringify(result.echo, null, 2)}`,
          time: nowLabel(),
        },
      ])
      setHealth({ kind: 'online', text: 'Completed' })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: 'error',
          content: text,
          time: nowLabel(),
        },
      ])
      setHealth({ kind: 'error', text })
    } finally {
      setBusy(false)
    }
  }

  function updateDraft<K extends keyof SettingsResult>(key: K, value: SettingsResult[K]) {
    setDraftSettings((current) => ({
      ...current,
      [key]: value,
    }))
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">
            <img src="/icons/message-bot.svg" alt="" />
          </span>
          <div>
            <h1>Brosdk Assistant</h1>
            <p>{nativeStatus.connected ? 'Native agent connected' : 'Native agent bridge'}</p>
          </div>
        </div>
        <div className="toolbar">
          <button
            className="icon-button"
            type="button"
            title="Check native host"
            onClick={() => void checkNative()}
          >
            <RefreshCw size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            title="Settings"
            onClick={() => setSettingsOpen((value) => !value)}
          >
            <Settings size={16} />
          </button>
          <button className="icon-button" type="button" title="New chat" onClick={startNewChat}>
            <Eraser size={16} />
          </button>
        </div>
      </header>

      <section className={`status-strip ${health.kind}`}>
        {statusIcon}
        <span>{health.text}</span>
      </section>

      {settingsOpen && (
        <section className="settings-panel">
          <label htmlFor="mcp-url">MCP URL</label>
          <input
            id="mcp-url"
            value={draftSettings.mcp_url}
            onChange={(event) => updateDraft('mcp_url', event.target.value)}
            placeholder={DEFAULT_SETTINGS.mcp_url}
          />

          <label htmlFor="model-api-type">Model API Type</label>
          <select
            id="model-api-type"
            value={draftSettings.model_api_type}
            onChange={(event) => updateDraft('model_api_type', event.target.value as ModelApiType)}
          >
            <option value="openai-compatible">OpenAI compatible</option>
            <option value="deepseek">DeepSeek</option>
            <option value="openai">OpenAI</option>
            <option value="custom">Custom</option>
          </select>

          <label htmlFor="model-base-url">Model Base URL</label>
          <input
            id="model-base-url"
            value={draftSettings.model_base_url}
            onChange={(event) => updateDraft('model_base_url', event.target.value)}
            placeholder={DEFAULT_SETTINGS.model_base_url}
          />

          <label htmlFor="model-name">Model Name</label>
          <input
            id="model-name"
            value={draftSettings.model_name}
            onChange={(event) => updateDraft('model_name', event.target.value)}
            placeholder={DEFAULT_SETTINGS.model_name}
          />

          <label htmlFor="api-key">Model API Key</label>
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
            step="0.1"
            type="number"
          />

          <label htmlFor="workspace-dir">Workspace Folder</label>
          <div className="settings-row">
            <input
              id="workspace-dir"
              value={draftSettings.workspace_dir}
              onChange={(event) => updateDraft('workspace_dir', event.target.value)}
              placeholder="D:\work\my-project"
            />
            <button className="icon-button primary" type="button" title="Save" onClick={saveSettings}>
              <Save size={16} />
            </button>
          </div>
        </section>
      )}

      <section className="config-context">
        <span>MCP</span>
        <strong title={settings.mcp_url}>{settings.mcp_url}</strong>
        <span>Model</span>
        <strong title={`${settings.model_base_url} · ${settings.model_name}`}>
          {settings.model_name} · {settings.model_api_type}
        </strong>
        <span>Workspace</span>
        <strong title={settings.workspace_dir}>{settings.workspace_dir ? shortPath(settings.workspace_dir) : 'No workspace'}</strong>
      </section>

      <div className="messages" ref={messagesRef}>
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          messages.map((message) => <MessageBubble key={message.id} message={message} />)
        )}
      </div>

      <footer className="chat-footer">
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault()
            void submitPrompt()
          }}
        >
          <textarea
            ref={inputRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submitPrompt()
              }
            }}
            placeholder="What should I do?"
            disabled={busy}
            rows={1}
          />
          <button className="send-button" type={busy ? 'button' : 'submit'} disabled={!canSend && !busy}>
            {busy ? <Square size={15} /> : <Send size={15} />}
          </button>
        </form>
      </footer>
    </main>
  )
}

function EmptyState() {
  return (
    <section className="empty-state">
      <h2>What should I do?</h2>
      <p>Configure MCP and model settings, then start a native-host backed assistant session.</p>
    </section>
  )
}

function MessageBubble({ message }: { message: ChatMessage }) {
  return (
    <article className={`message ${message.role}`}>
      <div className="message-meta">
        <strong>{message.role === 'user' ? 'You' : message.role === 'error' ? 'Error' : 'Agent'}</strong>
        <span>{message.time}</span>
      </div>
      <div className="message-body">{message.content}</div>
    </article>
  )
}

