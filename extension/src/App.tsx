import { useEffect, useMemo, useState } from 'react'
import { callNative, getNativeStatus } from './nativeClient'
import type { ChatMessage, EchoResult, HealthResult, NativeStatus, SettingsResult } from './types'

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function App() {
  const [status, setStatus] = useState<NativeStatus>({ connected: false })
  const [health, setHealth] = useState<HealthResult | null>(null)
  const [settings, setSettings] = useState<SettingsResult | null>(null)
  const [prompt, setPrompt] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)

  const statusText = useMemo(() => {
    if (health?.ok) return `${health.service} ${health.version} pid=${health.pid}`
    if (status.connected) return 'Native host connected'
    return status.lastError || 'Native host not connected'
  }, [health, status])

  async function refreshHealth() {
    setBusy(true)
    try {
      const result = await callNative<HealthResult>('agent.health')
      const nextSettings = await callNative<SettingsResult>('settings.get')
      setHealth(result)
      setSettings(nextSettings)
      setStatus(await getNativeStatus())
    } catch (error) {
      setHealth(null)
      setStatus({
        connected: false,
        lastError: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(false)
    }
  }

  async function submitPrompt() {
    const raw = prompt.trim()
    if (!raw || busy) return

    setPrompt('')
    setMessages((current) => [...current, { id: createId(), role: 'user', content: raw }])
    setBusy(true)
    try {
      const result = await callNative<EchoResult>('agent.echo', { message: raw })
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: 'assistant',
          content: `Native host echo:\n${JSON.stringify(result.echo, null, 2)}`,
        },
      ])
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: 'error',
          content: error instanceof Error ? error.message : String(error),
        },
      ])
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void refreshHealth()
  }, [])

  return (
    <main className="app-shell">
      <header className="app-header">
        <span className="brand-mark" aria-hidden="true">
          <img src="/icons/message-bot.svg" alt="" />
        </span>
        <div className="brand-copy">
          <h1>Brosdk Assistant</h1>
          <p>{statusText}</p>
        </div>
        <button type="button" onClick={() => void refreshHealth()} disabled={busy}>
          Check
        </button>
      </header>

      {settings && (
        <section className="status-panel">
          <span>Workspace</span>
          <strong>{settings.workspace_dir || '(not set)'}</strong>
          <span>Model</span>
          <strong>{settings.model}</strong>
        </section>
      )}

      <section className="messages">
        {messages.length === 0 ? (
          <div className="empty-state">
            <h2>Native host bridge ready</h2>
            <p>Send a message to verify the Chrome extension to Rust host loop.</p>
          </div>
        ) : (
          messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <strong>{message.role === 'user' ? 'You' : message.role === 'error' ? 'Error' : 'Assistant'}</strong>
              <pre>{message.content}</pre>
            </article>
          ))
        )}
      </section>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          void submitPrompt()
        }}
      >
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Ask the native host..."
          disabled={busy}
        />
        <button type="submit" disabled={!prompt.trim() || busy}>
          Send
        </button>
      </form>
    </main>
  )
}

