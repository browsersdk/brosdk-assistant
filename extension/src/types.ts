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
  tools?: unknown[]
  tool_name_map?: Record<string, string>
}

export type SettingsResult = {
  configured: boolean
  workspace_dir: string
  mcp_url: string
  model_base_url: string
  model_name: string
  model_api_type: ModelApiType
  api_key: string
  temperature: number
}

export type ModelApiType = 'openai' | 'anthropic'

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'error'
  content: string
  time: string
}
