export type NativeRequest = {
  id: string
  method: string
  params?: unknown
}

export type NativeResponse<T = unknown> = {
  id: string
  result?: T
  error?: {
    code: string
    message: string
  }
}

export type NativeEvent<T = unknown> = {
  event: string
  payload?: T
}

export type BackgroundRequest =
  | {
      type: 'native.request'
      request: NativeRequest
    }
  | {
      type: 'native.status'
    }
  | {
      type: 'settings.changed'
      settings: SettingsResult
    }
  | {
      type: 'extension.tool.invoke'
      name: string
      arguments?: unknown
    }
  | {
      type: 'native.event'
      event: NativeEvent
    }

export type BackgroundResponse<T = unknown> = {
  ok: boolean
  data?: T
  error?: string
}

export type NativeStatus = {
  connected: boolean
  lastError?: string
}

export type HealthResult = {
  ok: boolean
  service: string
  version: string
  pid: number
}

export type EchoResult = {
  echo: unknown
}

export type AgentRunResult = {
  accepted: boolean
  message: string
  llm_tool_count: number
  mcp_tool_count: number
  extension_tool_count?: number
  workspace_tool_count?: number
  details_available?: boolean
}

export type AgentStartResult = {
  run_id: string
  conversation_id: string
  state: 'queued'
}

export type AgentEventPayload = {
  run_id: string
  conversation_id?: string
  client_id?: string
  state?: string
  result?: AgentRunResult
  error?: {
    code: string
    message: string
  }
  tool_call_id?: string
  tool_name?: string
  ok?: boolean
  delta?: string
  confirmation_id?: string
  summary?: string
  arguments?: unknown
  expires_in_ms?: number
  decision?: 'approved' | 'denied'
}

export type AgentConfirmationRequest = {
  run_id: string
  conversation_id?: string
  client_id?: string
  confirmation_id: string
  tool_call_id: string
  tool_name: string
  summary: string
  arguments?: unknown
  expires_in_ms?: number
}

export type AgentRunDebugInfo = {
  system_prompt: string
  user_message: string
  attached_tabs_context?: string
  messages: unknown[]
  llm_tool_count: number
  mcp_tool_count: number
  extension_tool_count?: number
  workspace_tool_count?: number
  workspace_dir?: string
  default_workspace_dir?: string
  tool_name_map?: Record<string, string>
  tools?: unknown[]
  tool_results?: unknown[]
  details_truncated?: boolean
  messages_omitted?: number
  tool_results_omitted?: number
  tools_omitted?: number
}

export type AgentRunDetailsResult = {
  run_id: string
  conversation_id: string
  state: 'completed'
  debug: AgentRunDebugInfo
}

export type SettingsResult = {
  configured: boolean
  workspace_dir: string
  default_workspace_dir?: string
  browser_tools_mode: BrowserToolsMode
  mcp_url: string
  model_base_url: string
  model_name: string
  model_api_type: ModelApiType
  api_key: string
  temperature: number
  open_side_panel_on_action_click: boolean
  side_panel_per_window: boolean
}

export type ModelApiType = 'openai' | 'anthropic'
export type BrowserToolsMode = 'mcp' | 'extension' | 'off'

export type WorkspaceFolder = {
  id: string
  name: string
  path: string
  addedAt: number
}

export type FileSystemEntry = {
  name: string
  path: string
  kind: 'directory'
}

export type FileSystemListResult = {
  path: string | null
  parent: string | null
  entries: FileSystemEntry[]
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'error'
  content: string
  time: string
  runId?: string
  detailsAvailable?: boolean
  streaming?: boolean
}
