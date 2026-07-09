import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Eraser,
  Folder,
  FolderOpen,
  Globe,
  Info,
  Layers,
  MessageSquare,
  MousePointer2,
  RefreshCw,
  Search,
  Send,
  Settings,
  Square,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { callNative, getNativeStatus } from './nativeClient'
import {
  DEFAULT_SETTINGS,
  isSettingsConfigured,
  normalizeSettings,
} from './settings'
import type {
  AgentRunResult,
  ChatMessage,
  FileSystemEntry,
  FileSystemListResult,
  HealthResult,
  NativeStatus,
  SettingsResult,
  WorkspaceFolder,
} from './types'

type HealthState =
  | { kind: 'checking'; text: string }
  | { kind: 'online'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'idle'; text: string }

type ChatMode = 'agent' | 'chat'

const WORKSPACE_FOLDERS_STORAGE_KEY = 'brosdk-assistant-workspace-folders'
const MAX_RECENT_WORKSPACES = 10

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function folderNameFromPath(path: string) {
  const normalized = path.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]/)
  return parts.at(-1) || normalized || 'Workspace'
}

function isExplicitWorkspace(path?: string) {
  return Boolean(path && path.trim())
}

function isOwnExtensionTab(tab: chrome.tabs.Tab) {
  return Boolean(tab.url?.startsWith(chrome.runtime.getURL('')))
}

function isAttachableTab(tab: chrome.tabs.Tab) {
  return typeof tab.id === 'number' && !isOwnExtensionTab(tab)
}

async function queryAttachableTabs(query: chrome.tabs.QueryInfo = {}) {
  const tabs = await chrome.tabs.query(query).catch(() => [])
  return tabs.filter(isAttachableTab)
}

function sortTabsForPicker(tabs: chrome.tabs.Tab[]) {
  return [...tabs].sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1
    return (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0)
  })
}

async function loadAttachableTabs() {
  const currentWindowTabs = await queryAttachableTabs({ currentWindow: true })
  if (currentWindowTabs.length > 0) return sortTabsForPicker(currentWindowTabs)

  const lastFocusedTabs = await queryAttachableTabs({ lastFocusedWindow: true })
  if (lastFocusedTabs.length > 0) return sortTabsForPicker(lastFocusedTabs)

  const allTabs = await queryAttachableTabs({})
  const seen = new Set<number>()
  return sortTabsForPicker(
    allTabs.filter((tab) => {
      if (!tab.id || seen.has(tab.id)) return false
      seen.add(tab.id)
      return true
    }),
  )
}

async function loadRecentWorkspaceFolders(): Promise<WorkspaceFolder[]> {
  const result = await chrome.storage.local.get(WORKSPACE_FOLDERS_STORAGE_KEY)
  return Array.isArray(result[WORKSPACE_FOLDERS_STORAGE_KEY])
    ? (result[WORKSPACE_FOLDERS_STORAGE_KEY] as WorkspaceFolder[])
    : []
}

async function saveRecentWorkspaceFolders(folders: WorkspaceFolder[]) {
  await chrome.storage.local.set({
    [WORKSPACE_FOLDERS_STORAGE_KEY]: folders.slice(0, MAX_RECENT_WORKSPACES),
  })
}

export function App() {
  const [nativeStatus, setNativeStatus] = useState<NativeStatus>({ connected: false })
  const [health, setHealth] = useState<HealthState>({
    kind: 'idle',
    text: 'Native host not checked',
  })
  const [settings, setSettings] = useState<SettingsResult>(DEFAULT_SETTINGS)
  const [recentWorkspaces, setRecentWorkspaces] = useState<WorkspaceFolder[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [mode, setMode] = useState<ChatMode>('agent')
  const [attachedTabs, setAttachedTabs] = useState<chrome.tabs.Tab[]>([])
  const [availableTabs, setAvailableTabs] = useState<chrome.tabs.Tab[]>([])
  const [tabPickerOpen, setTabPickerOpen] = useState(false)
  const [tabFilter, setTabFilter] = useState('')
  const [tabLoading, setTabLoading] = useState(false)
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
  const [workspaceFilter, setWorkspaceFilter] = useState('')
  const [workspaceBrowserPath, setWorkspaceBrowserPath] = useState<string | null>(null)
  const [workspaceBrowserParent, setWorkspaceBrowserParent] = useState<string | null>(null)
  const [workspaceBrowserEntries, setWorkspaceBrowserEntries] = useState<FileSystemEntry[]>([])
  const [workspaceBrowserLoading, setWorkspaceBrowserLoading] = useState(false)
  const [workspaceBrowserError, setWorkspaceBrowserError] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const messagesRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pickerLayerRef = useRef<HTMLDivElement>(null)
  const tabPickerButtonRef = useRef<HTMLButtonElement>(null)
  const workspacePickerButtonRef = useRef<HTMLButtonElement>(null)

  const configured = isSettingsConfigured(settings)
  const canSend = prompt.trim().length > 0 && !busy && configured
  const selectedWorkspace = isExplicitWorkspace(settings.workspace_dir)
    ? {
        id: settings.workspace_dir,
        name: folderNameFromPath(settings.workspace_dir),
        path: settings.workspace_dir,
        addedAt: 0,
      }
    : null

  const statusIcon = useMemo(() => {
    if (health.kind === 'online') return <CircleCheck size={16} />
    if (health.kind === 'error') return <CircleAlert size={16} />
    return <CircleDot size={16} />
  }, [health.kind])

  useEffect(() => {
    void checkNative()
    void attachActiveTab()
    void refreshRecentWorkspaces()
  }, [])

  useEffect(() => {
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [messages])

  useEffect(() => {
    if (!tabPickerOpen && !workspacePickerOpen) return

    function closePickersOnOutsideClick(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      if (pickerLayerRef.current?.contains(target)) return
      if (tabPickerButtonRef.current?.contains(target)) return
      if (workspacePickerButtonRef.current?.contains(target)) return
      setTabPickerOpen(false)
      setWorkspacePickerOpen(false)
    }

    document.addEventListener('pointerdown', closePickersOnOutsideClick)
    return () => document.removeEventListener('pointerdown', closePickersOnOutsideClick)
  }, [tabPickerOpen, workspacePickerOpen])

  async function refreshRecentWorkspaces() {
    const folders = await loadRecentWorkspaceFolders().catch(() => [])
    setRecentWorkspaces(folders)
  }

  async function persistSettings(nextSettings: SettingsResult) {
    const saved = normalizeSettings(await callNative<SettingsResult>('settings.set', nextSettings))
    setSettings(saved)
    await chrome.runtime
      .sendMessage({ type: 'settings.changed', settings: saved })
      .catch(() => undefined)
    return saved
  }

  async function checkNative() {
    setHealth({ kind: 'checking', text: 'Loading configuration...' })
    setSettings(DEFAULT_SETTINGS)

    setHealth({ kind: 'checking', text: 'Checking native host...' })
    try {
      const result = await callNative<HealthResult>('agent.health')
      const nativeSettings = normalizeSettings(await callNative<SettingsResult>('settings.get'))
      setSettings(nativeSettings)
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
    setAttachedTabs([])
    setHealth({ kind: 'idle', text: 'Chat reset' })
    await callNative('agent.reset').catch(() => undefined)
    inputRef.current?.focus()
  }

  async function attachActiveTab() {
    const currentWindowTabs = await queryAttachableTabs({ active: true, currentWindow: true })
    const lastFocusedTabs =
      currentWindowTabs.length > 0
        ? currentWindowTabs
        : await queryAttachableTabs({ active: true, lastFocusedWindow: true })
    const tab = lastFocusedTabs[0] ?? (await loadAttachableTabs())[0]
    if (!tab?.id) return
    setAttachedTabs((current) => {
      if (current.some((item) => item.id === tab.id)) return current
      return [tab]
    })
  }

  async function openTabPicker() {
    if (tabPickerOpen) {
      setTabPickerOpen(false)
      return
    }

    setTabLoading(true)
    setWorkspacePickerOpen(false)
    setTabPickerOpen(true)
    try {
      setAvailableTabs(await loadAttachableTabs())
    } catch {
      setAvailableTabs([])
    } finally {
      setTabLoading(false)
    }
  }

  function toggleAttachedTab(tab: chrome.tabs.Tab) {
    if (!tab.id) return
    setAttachedTabs((current) => {
      if (current.some((item) => item.id === tab.id)) {
        return current.filter((item) => item.id !== tab.id)
      }
      return [...current, tab]
    })
  }

  function removeAttachedTab(tabId?: number) {
    setAttachedTabs((current) => current.filter((tab) => tab.id !== tabId))
  }

  async function openWorkspacePicker() {
    if (workspacePickerOpen) {
      setWorkspacePickerOpen(false)
      return
    }
    setTabPickerOpen(false)
    setWorkspacePickerOpen(true)
    setWorkspaceFilter('')
    await loadWorkspaceBrowser(
      isExplicitWorkspace(settings.workspace_dir) ? settings.workspace_dir : null,
    )
  }

  async function loadWorkspaceBrowser(path: string | null) {
    setWorkspaceBrowserLoading(true)
    setWorkspaceBrowserError(null)
    try {
      const result = path
        ? await callNative<FileSystemListResult>('filesystem.list', { path })
        : await callNative<FileSystemListResult>('filesystem.roots')
      setWorkspaceBrowserPath(result.path)
      setWorkspaceBrowserParent(result.parent)
      setWorkspaceBrowserEntries(result.entries ?? [])
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setWorkspaceBrowserPath(path)
      setWorkspaceBrowserParent(null)
      setWorkspaceBrowserEntries([])
      setWorkspaceBrowserError(text)
    } finally {
      setWorkspaceBrowserLoading(false)
    }
  }

  async function selectWorkspaceFolder(folder: WorkspaceFolder | null) {
    setWorkspacePickerOpen(false)
    setWorkspaceFilter('')

    if (!folder) {
      try {
        await persistSettings({
          ...settings,
          workspace_dir: '',
        })
        setHealth({ kind: 'idle', text: 'Local file tools off' })
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        setHealth({ kind: 'error', text: `Failed to clear workspace: ${text}` })
      }
      return
    }

    try {
      await persistSettings({
        ...settings,
        workspace_dir: folder.path,
      })
      const current = await loadRecentWorkspaceFolders().catch(() => [])
      const updated = [
        { ...folder, addedAt: Date.now() },
        ...current.filter((item) => item.path !== folder.path),
      ].slice(0, MAX_RECENT_WORKSPACES)
      await saveRecentWorkspaceFolders(updated)
      setRecentWorkspaces(updated)
      setHealth({ kind: 'online', text: `Workspace selected: ${folder.path}` })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setHealth({ kind: 'error', text: `Failed to select workspace: ${text}` })
    }
  }

  async function selectCurrentBrowserFolder() {
    if (!workspaceBrowserPath) {
      setHealth({ kind: 'idle', text: 'Open a folder before selecting it' })
      return
    }
    await selectWorkspaceFolder({
      id: crypto.randomUUID(),
      name: folderNameFromPath(workspaceBrowserPath),
      path: workspaceBrowserPath,
      addedAt: Date.now(),
    })
  }

  async function removeRecentWorkspace(event: ReactMouseEvent, folderId: string) {
    event.stopPropagation()
    const updated = recentWorkspaces.filter((folder) => folder.id !== folderId)
    await saveRecentWorkspaceFolders(updated)
    setRecentWorkspaces(updated)
    const removedSelected = recentWorkspaces.find((folder) => folder.id === folderId)
    if (removedSelected?.path === settings.workspace_dir) {
      await selectWorkspaceFolder(null)
    }
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
        mode,
        attached_tabs: attachedTabs.map((tab) => ({
          tabId: tab.id,
          title: tab.title,
          url: tab.url,
        })),
        settings,
      })
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: 'assistant',
          content: result.message,
          time: nowLabel(),
          debug: result.debug,
        },
      ])
      setAttachedTabs([])
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
    const url = chrome.runtime.getURL('settings.html')
    void chrome.tabs.create({ active: true, url }).catch(() => chrome.runtime.openOptionsPage())
  }

  return (
    <main className={`app-shell ${configured ? 'configured' : 'needs-config'}`}>
      <header className="chat-header">
        <button className="provider-button" type="button" title="Assistant provider">
          <Bot size={18} />
          <span>Brosdk</span>
        </button>
        <div className="header-actions">
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

      {!configured && <ConfigureNotice onConfigure={openOptionsPage} />}

      <div className="messages" ref={messagesRef}>
        {messages.length === 0 ? (
          <EmptyState
            mode={mode}
            onSuggestionClick={(value) => {
              setPrompt(value)
              inputRef.current?.focus()
            }}
          />
        ) : (
          messages.map((message) => <MessageBubble key={message.id} message={message} />)
        )}
      </div>

      <footer className="chat-footer">
        <AttachedTabs tabs={attachedTabs} onRemoveTab={removeAttachedTab} />
        <div className="footer-toolbar">
          <button
            className={`mode-toggle ${mode}`}
            type="button"
            title={mode === 'agent' ? 'Allow tool use and task actions' : 'Read-only conversation'}
            onClick={() => setMode((current) => (current === 'agent' ? 'chat' : 'agent'))}
          >
            {mode === 'agent' ? <MousePointer2 size={13} /> : <MessageSquare size={13} />}
            <span>{mode === 'agent' ? 'Agent Mode' : 'Chat Mode'}</span>
          </button>
          <span className="toolbar-divider" />
          <button
            ref={tabPickerButtonRef}
            className="footer-tool-button"
            type="button"
            title="Attach tabs"
            data-state={tabPickerOpen ? 'open' : 'closed'}
            onClick={() => void openTabPicker()}
          >
            <Layers size={16} />
            {attachedTabs.length > 0 && <strong>{attachedTabs.length}</strong>}
            <ChevronDown size={12} />
          </button>
          <button
            ref={workspacePickerButtonRef}
            className="footer-tool-button"
            type="button"
            title={selectedWorkspace ? selectedWorkspace.name : 'Select workspace folder'}
            data-state={workspacePickerOpen ? 'open' : 'closed'}
            onClick={() => void openWorkspacePicker()}
          >
            <Folder size={16} />
            {selectedWorkspace && <span className="active-dot" />}
            <ChevronDown size={12} />
          </button>
        </div>
        <div className="picker-layer" ref={pickerLayerRef}>
          {tabPickerOpen && (
            <TabPicker
              tabs={availableTabs}
              selectedTabs={attachedTabs}
              filterText={tabFilter}
              isLoading={tabLoading}
              onFilterTextChange={setTabFilter}
              onToggleTab={toggleAttachedTab}
              onClose={() => setTabPickerOpen(false)}
            />
          )}
          {workspacePickerOpen && (
            <WorkspacePicker
              recentFolders={recentWorkspaces}
              selectedFolder={selectedWorkspace}
              defaultWorkspacePath={settings.default_workspace_dir}
              browserPath={workspaceBrowserPath}
              browserParent={workspaceBrowserParent}
              browserEntries={workspaceBrowserEntries}
              browserError={workspaceBrowserError}
              filterText={workspaceFilter}
              isLoading={workspaceBrowserLoading}
              onFilterTextChange={setWorkspaceFilter}
              onSelectFolder={(folder) => void selectWorkspaceFolder(folder)}
              onOpenFolder={(path) => void loadWorkspaceBrowser(path)}
              onGoToParent={() => void loadWorkspaceBrowser(workspaceBrowserParent)}
              onGoToRoots={() => void loadWorkspaceBrowser(null)}
              onSelectCurrentFolder={() => void selectCurrentBrowserFolder()}
              onRemoveFolder={(event, folderId) => void removeRecentWorkspace(event, folderId)}
            />
          )}
        </div>
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
            placeholder={
              configured
                ? mode === 'agent'
                  ? 'What should I do?'
                  : 'Ask about this page...'
                : '请先前往配置'
            }
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

function TabPicker({
  tabs,
  selectedTabs,
  filterText,
  isLoading,
  onFilterTextChange,
  onToggleTab,
  onClose,
}: {
  tabs: chrome.tabs.Tab[]
  selectedTabs: chrome.tabs.Tab[]
  filterText: string
  isLoading: boolean
  onFilterTextChange: (value: string) => void
  onToggleTab: (tab: chrome.tabs.Tab) => void
  onClose: () => void
}) {
  const selectedIds = new Set(selectedTabs.map((tab) => tab.id))
  const search = filterText.trim().toLowerCase()
  const filteredTabs = search
    ? tabs.filter(
        (tab) =>
          tab.title?.toLowerCase().includes(search) || tab.url?.toLowerCase().includes(search),
      )
    : tabs

  return (
    <div className="picker-popover" role="dialog" aria-label="Select tabs">
      <PickerSearch
        value={filterText}
        placeholder="Search tabs..."
        onChange={onFilterTextChange}
        onClose={onClose}
      />
      <div className="picker-title-row">
        <span>Tabs</span>
        {selectedTabs.length > 0 && <strong>{selectedTabs.length} selected</strong>}
      </div>
      <div className="picker-list" role="listbox" aria-multiselectable="true">
        {isLoading ? (
          <div className="picker-empty">Loading tabs...</div>
        ) : filteredTabs.length === 0 ? (
          <div className="picker-empty">
            {tabs.length === 0 ? 'No tabs available' : `No tabs matching "${filterText}"`}
          </div>
        ) : (
          filteredTabs.map((tab) => {
            const selected = selectedIds.has(tab.id)
            return (
              <button
                className={`picker-row tab-picker-row ${selected ? 'selected' : ''}`}
                key={tab.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => onToggleTab(tab)}
              >
                <span className="picker-check">{selected && <Check size={12} />}</span>
                <span className="tab-favicon">
                  {tab.favIconUrl ? <img src={tab.favIconUrl} alt="" /> : <Globe size={12} />}
                </span>
                <span className="picker-row-text">
                  <span>{tab.title || 'Untitled tab'}</span>
                  <small>{tab.url}</small>
                </span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

function WorkspacePicker({
  recentFolders,
  selectedFolder,
  defaultWorkspacePath,
  browserPath,
  browserParent,
  browserEntries,
  browserError,
  filterText,
  isLoading,
  onFilterTextChange,
  onSelectFolder,
  onOpenFolder,
  onGoToParent,
  onGoToRoots,
  onSelectCurrentFolder,
  onRemoveFolder,
}: {
  recentFolders: WorkspaceFolder[]
  selectedFolder: WorkspaceFolder | null
  defaultWorkspacePath?: string
  browserPath: string | null
  browserParent: string | null
  browserEntries: FileSystemEntry[]
  browserError: string | null
  filterText: string
  isLoading: boolean
  onFilterTextChange: (value: string) => void
  onSelectFolder: (folder: WorkspaceFolder | null) => void
  onOpenFolder: (path: string) => void
  onGoToParent: () => void
  onGoToRoots: () => void
  onSelectCurrentFolder: () => void
  onRemoveFolder: (event: ReactMouseEvent, folderId: string) => void
}) {
  const search = filterText.trim().toLowerCase()
  const filteredFolders = search
    ? recentFolders.filter(
        (folder) =>
          folder.name.toLowerCase().includes(search) || folder.path.toLowerCase().includes(search),
      )
    : recentFolders
  const filteredEntries = search
    ? browserEntries.filter(
        (entry) =>
          entry.name.toLowerCase().includes(search) || entry.path.toLowerCase().includes(search),
      )
    : browserEntries
  const defaultWorkspace =
    defaultWorkspacePath && (!search || defaultWorkspacePath.toLowerCase().includes(search))
      ? {
          id: 'default-workspace',
          name: 'Default workspace',
          path: defaultWorkspacePath,
          addedAt: 0,
        }
      : null

  return (
    <div className="picker-popover workspace-picker" role="dialog" aria-label="Select workspace folder">
      <PickerSearch
        value={filterText}
        placeholder="Search folders..."
        onChange={onFilterTextChange}
      />
      <div className="picker-list workspace-picker-list">
        {defaultWorkspace && (
          <button
            className={`picker-row workspace-row ${
              selectedFolder?.path === defaultWorkspace.path ? 'selected' : ''
            }`}
            type="button"
            onClick={() => onSelectFolder(defaultWorkspace)}
          >
            <Folder size={16} />
            <span className="picker-row-text">
              <span>Default workspace</span>
              <small>{defaultWorkspace.path}</small>
            </span>
            {selectedFolder?.path === defaultWorkspace.path && (
              <Check className="picker-selected-icon" size={15} />
            )}
          </button>
        )}
        <button className="picker-row" type="button" onClick={() => onSelectFolder(null)}>
          <Globe size={16} />
          <span className="picker-row-text">
            <span>No workspace</span>
            <small>Disable local file tools for this assistant</small>
          </span>
          {!selectedFolder && <Check className="picker-selected-icon" size={15} />}
        </button>

        {filteredFolders.length > 0 && <div className="picker-title-row">Recent</div>}
        {filteredFolders.map((folder) => {
          const selected = selectedFolder?.path === folder.path
          return (
            <button
              className={`picker-row workspace-row ${selected ? 'selected' : ''}`}
              key={folder.id}
              type="button"
              onClick={() => onSelectFolder(selected ? null : folder)}
            >
              <Folder size={16} />
              <span className="picker-row-text">
                <span>{folder.name}</span>
                <small>{folder.path}</small>
              </span>
              {selected && <Check className="picker-selected-icon" size={15} />}
              <span
                className="picker-remove-button"
                role="button"
                tabIndex={0}
                title={`Remove ${folder.name} from recents`}
                onClick={(event) => onRemoveFolder(event, folder.id)}
              >
                <X size={12} />
              </span>
            </button>
          )
        })}
        {filteredFolders.length === 0 && recentFolders.length > 0 && (
          <div className="picker-empty">No folders matching "{filterText}"</div>
        )}

        <div className="picker-title-row">
          <span>{browserPath ? 'Browse folders' : 'Local disks'}</span>
          {browserPath && <strong title={browserPath}>{folderNameFromPath(browserPath)}</strong>}
        </div>

        <div className="workspace-browser-actions">
          <button type="button" onClick={onGoToRoots}>
            <Globe size={14} />
            <span>Roots</span>
          </button>
          <button type="button" disabled={!browserParent} onClick={onGoToParent}>
            <ArrowUp size={14} />
            <span>Up</span>
          </button>
        </div>

        {browserPath && (
          <div className="workspace-current-path" title={browserPath}>
            {browserPath}
          </div>
        )}

        {browserError && <div className="picker-empty">{browserError}</div>}
        {isLoading ? (
          <div className="picker-empty">Loading folders...</div>
        ) : filteredEntries.length === 0 && !browserError ? (
          <div className="picker-empty">
            {browserEntries.length === 0 ? 'No folders available' : `No folders matching "${filterText}"`}
          </div>
        ) : (
          filteredEntries.map((entry) => (
            <button
              className="picker-row browser-folder-row"
              key={entry.path}
              type="button"
              onClick={() => onOpenFolder(entry.path)}
            >
              <Folder size={16} />
              <span className="picker-row-text">
                <span>{entry.name}</span>
                <small>{entry.path}</small>
              </span>
              <ChevronDown className="folder-enter-icon" size={13} />
            </button>
          ))
        )}
      </div>
      <button
        className="choose-folder-button"
        type="button"
        disabled={!browserPath || isLoading}
        onClick={onSelectCurrentFolder}
      >
        <FolderOpen size={16} />
        <span>Select current folder</span>
      </button>
    </div>
  )
}

function PickerSearch({
  value,
  placeholder,
  onChange,
  onClose,
}: {
  value: string
  placeholder: string
  onChange: (value: string) => void
  onClose?: () => void
}) {
  return (
    <div className="picker-search">
      <Search size={14} />
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      {onClose && (
        <button type="button" title="Close" onClick={onClose}>
          <X size={14} />
        </button>
      )}
    </div>
  )
}

function AttachedTabs({
  tabs,
  onRemoveTab,
}: {
  tabs: chrome.tabs.Tab[]
  onRemoveTab: (tabId?: number) => void
}) {
  if (tabs.length === 0) return null
  return (
    <div className="attached-tabs">
      <div className="attached-tabs-scroll">
        {tabs.map((tab) => (
          <div className="attached-tab" key={tab.id}>
            <span className="tab-favicon">
              {tab.favIconUrl ? <img src={tab.favIconUrl} alt="" /> : <Globe size={12} />}
            </span>
            <span>{tab.title || tab.url || 'Current tab'}</span>
            <button type="button" title="Remove tab" onClick={() => onRemoveTab(tab.id)}>
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
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

function EmptyState({
  mode,
  onSuggestionClick,
}: {
  mode: ChatMode
  onSuggestionClick: (value: string) => void
}) {
  const suggestions =
    mode === 'agent'
      ? [
          'Summarize this page and find next actions',
          'Inspect local files with available tools',
          'Help me complete this browser task',
        ]
      : ['Summarize this page', 'What is important here?', 'Draft a reply based on this page']
  return (
    <section className="empty-state">
      <div className="empty-mark">
        <Bot size={28} />
      </div>
      <h2>{mode === 'agent' ? 'Agent at your service' : 'Chat with this page'}</h2>
      <p>
        {mode === 'agent'
          ? 'Let AI automate tasks and use your connected tools.'
          : 'Ask questions about the current page or any topic.'}
      </p>
      <div className="suggestions">
        {suggestions.map((suggestion) => (
          <button key={suggestion} type="button" onClick={() => onSuggestionClick(suggestion)}>
            {suggestion}
          </button>
        ))}
      </div>
    </section>
  )
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const [debugOpen, setDebugOpen] = useState(false)
  return (
    <article className={`message ${message.role}`}>
      <div className="message-meta">
        <strong>{message.role === 'user' ? 'You' : message.role === 'error' ? 'Error' : 'Agent'}</strong>
        <span className="message-meta-actions">
          <span>{message.time}</span>
          {message.debug && (
            <button
              className="message-debug-button"
              type="button"
              title="View run details"
              onClick={() => setDebugOpen(true)}
            >
              <Info size={14} />
            </button>
          )}
        </span>
      </div>
      <div className="message-body">
        {message.role === 'assistant' ? (
          <MarkdownContent text={message.content} />
        ) : (
          message.content
        )}
      </div>
      {debugOpen && message.debug && (
        <RunDetailsDialog debug={message.debug} onClose={() => setDebugOpen(false)} />
      )}
    </article>
  )
}

function MarkdownContent({ text }: { text: string }) {
  return <>{parseMarkdownBlocks(text).map((block, index) => renderMarkdownBlock(block, index))}</>
}

type MarkdownBlock =
  | { type: 'code'; language: string; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'paragraph'; text: string }

function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let paragraph: string[] = []
  let listItems: string[] = []
  let orderedList = false
  let codeLanguage = ''
  let codeLines: string[] | null = null

  function flushParagraph() {
    if (paragraph.length) {
      blocks.push({ type: 'paragraph', text: paragraph.join('\n') })
      paragraph = []
    }
  }

  function flushList() {
    if (listItems.length) {
      blocks.push({ type: 'list', ordered: orderedList, items: listItems })
      listItems = []
    }
  }

  for (const line of lines) {
    const fence = line.match(/^```([A-Za-z0-9_-]*)\s*$/)
    if (fence) {
      if (codeLines) {
        blocks.push({ type: 'code', language: codeLanguage, text: codeLines.join('\n') })
        codeLines = null
        codeLanguage = ''
      } else {
        flushParagraph()
        flushList()
        codeLanguage = fence[1] ?? ''
        codeLines = []
      }
      continue
    }

    if (codeLines) {
      codeLines.push(line)
      continue
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      flushList()
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
      continue
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/)
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/)
    if (unordered || ordered) {
      flushParagraph()
      const nextOrdered = Boolean(ordered)
      if (listItems.length && orderedList !== nextOrdered) flushList()
      orderedList = nextOrdered
      listItems.push((ordered?.[1] ?? unordered?.[1] ?? '').trim())
      continue
    }

    if (!line.trim()) {
      flushParagraph()
      flushList()
      continue
    }

    flushList()
    paragraph.push(line)
  }

  if (codeLines) blocks.push({ type: 'code', language: codeLanguage, text: codeLines.join('\n') })
  flushParagraph()
  flushList()
  return blocks
}

function renderMarkdownBlock(block: MarkdownBlock, index: number) {
  if (block.type === 'code') {
    return (
      <pre className="markdown-code-block" key={index}>
        {block.language && <span className="markdown-code-language">{block.language}</span>}
        <code>{block.text}</code>
      </pre>
    )
  }
  if (block.type === 'heading') {
    const Tag = (`h${block.level}` as 'h1' | 'h2' | 'h3')
    return <Tag key={index}>{renderInlineMarkdown(block.text)}</Tag>
  }
  if (block.type === 'list') {
    const Tag = block.ordered ? 'ol' : 'ul'
    return (
      <Tag key={index}>
        {block.items.map((item, itemIndex) => (
          <li key={`${index}-${itemIndex}`}>{renderInlineMarkdown(item)}</li>
        ))}
      </Tag>
    )
  }
  return <p key={index}>{renderInlineMarkdown(block.text)}</p>
}

function renderInlineMarkdown(text: string) {
  const parts: ReactNode[] = []
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g
  let lastIndex = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index))
    const token = match[0]
    if (token.startsWith('`')) {
      parts.push(<code key={parts.length}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      parts.push(<strong key={parts.length}>{token.slice(2, -2)}</strong>)
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (link) {
        parts.push(
          <a href={link[2]} key={parts.length} rel="noreferrer" target="_blank">
            {link[1]}
          </a>,
        )
      } else {
        parts.push(token)
      }
    }
    lastIndex = match.index + token.length
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return parts
}

function RunDetailsDialog({
  debug,
  onClose,
}: {
  debug: NonNullable<ChatMessage['debug']>
  onClose: () => void
}) {
  return (
    <div className="run-details-backdrop" role="presentation" onClick={onClose}>
      <section
        className="run-details-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Run details"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="run-details-header">
          <div>
            <h2>Run details</h2>
            <p>
              {debug.llm_tool_count} LLM tools · {debug.mcp_tool_count} MCP tools
            </p>
          </div>
          <button className="icon-button" type="button" title="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <pre className="run-details-content">{JSON.stringify(debug, null, 2)}</pre>
      </section>
    </div>
  )
}
