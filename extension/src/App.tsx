import {
  CircleAlert,
  CircleCheck,
  CircleDot,
  Eraser,
  RefreshCw,
  Send,
  Settings,
  Square,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { callNative, getNativeStatus } from './nativeClient'
import {
  DEFAULT_SETTINGS,
  formatModelApiType,
  isSettingsConfigured,
  loadStoredSettings,
  normalizeSettings,
} from './settings'
import type {
  AgentRunResult,
  ChatMessage,
  HealthResult,
  NativeStatus,
  SettingsResult,
} from './types'

type HealthState =
  | { kind: 'checking'; text: string }
  | { kind: 'online'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'idle'; text: string }

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
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const messagesRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const configured = isSettingsConfigured(settings)
  const canSend = prompt.trim().length > 0 && !busy && configured

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
    setHealth({ kind: 'checking', text: 'Loading configuration...' })
    try {
      const nextSettings = await loadStoredSettings()
      setSettings(normalizeSettings(nextSettings))
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setHealth({ kind: 'error', text: `Failed to load configuration: ${text}` })
      return
    }

    setHealth({ kind: 'checking', text: 'Checking native host...' })
    try {
      const result = await callNative<HealthResult>('agent.health')
      const status = await getNativeStatus()
      setNativeStatus(status)
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
      const result = await callNative<AgentRunResult>('agent.run', {
        message: raw,
        settings,
      })
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: 'assistant',
          content: `${result.message}\n\nPrepared ${result.llm_tool_count} LLM tools from ${result.mcp_tool_count} MCP tools.`,
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

  function openOptionsPage() {
    void chrome.runtime.openOptionsPage()
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
            onClick={openOptionsPage}
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

      {configured ? (
        <section className="config-context">
          <span>MCP</span>
          <strong title={settings.mcp_url}>{settings.mcp_url}</strong>
          <span>Model</span>
          <strong title={`${settings.model_base_url} · ${settings.model_name}`}>
            {settings.model_name} · {formatModelApiType(settings.model_api_type)}
          </strong>
          <span>Workspace</span>
          <strong title={settings.workspace_dir}>
            {settings.workspace_dir ? shortPath(settings.workspace_dir) : 'No workspace'}
          </strong>
        </section>
      ) : (
        <ConfigureNotice onConfigure={openOptionsPage} />
      )}

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
            placeholder={configured ? 'What should I do?' : '请先前往配置'}
            disabled={busy || !configured}
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

function ConfigureNotice({ onConfigure }: { onConfigure: () => void }) {
  return (
    <section className="configure-notice">
      <div>
        <h2>请前往配置</h2>
        <p>插件需要先配置 MCP、模型和工作目录后才能开始会话。</p>
      </div>
      <button className="configure-button" type="button" onClick={onConfigure}>
        <Settings size={15} />
        配置
      </button>
    </section>
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
