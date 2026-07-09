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
  workspace_tool_count?: number
  tools?: unknown[]
  tool_name_map?: Record<string, string>
  debug?: AgentRunDebugInfo
}

export type AgentRunDebugInfo = {
  system_prompt: string
  user_message: string
  attached_tabs_context?: string
  messages: unknown[]
  llm_tool_count: number
  mcp_tool_count: number
  workspace_tool_count?: number
  workspace_dir?: string
  default_workspace_dir?: string
  tool_name_map?: Record<string, string>
  tools?: unknown[]
  tool_results?: unknown[]
}

export type SettingsResult = {
  configured: boolean
  workspace_dir: string
  default_workspace_dir?: string
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
  debug?: AgentRunDebugInfo
}
