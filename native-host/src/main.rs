use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process;

const SERVICE_NAME: &str = "brosdk-assistant-native";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_INBOUND_BYTES: usize = 16 * 1024 * 1024;
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const OPENAI_TOOL_NAME_MAX_LENGTH: usize = 64;

#[derive(Debug, Deserialize)]
struct Request {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct Response {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorBody>,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: String,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Settings {
    workspace_dir: String,
    mcp_url: String,
    model_base_url: String,
    model_name: String,
    model_api_type: String,
    api_key: String,
    temperature: f64,
}

#[derive(Debug)]
struct McpHttpClient {
    url: String,
    http: Client,
    next_id: u64,
    session_id: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            workspace_dir: ".".to_string(),
            mcp_url: "http://127.0.0.1:3000/mcp".to_string(),
            model_base_url: String::new(),
            model_name: String::new(),
            model_api_type: "openai".to_string(),
            api_key: String::new(),
            temperature: 0.0,
        }
    }
}

fn main() {
    let (mut settings, mut settings_configured) = load_settings();
    let ready = json!({
        "event": "native.ready",
        "payload": {
            "service": SERVICE_NAME,
            "version": VERSION,
            "pid": process::id()
        }
    });
    if let Err(error) = write_message(&ready) {
        eprintln!("[native] failed to send ready event: {error}");
        return;
    }

    loop {
        let message = match read_message() {
            Ok(Some(value)) => value,
            Ok(None) => break,
            Err(error) => {
                eprintln!("[native] read failed: {error}");
                break;
            }
        };

        let request: Request = match serde_json::from_value(message) {
            Ok(request) => request,
            Err(error) => {
                eprintln!("[native] invalid request: {error}");
                continue;
            }
        };

        let response = handle_request(request, &mut settings, &mut settings_configured);
        if let Err(error) = write_response(&response) {
            eprintln!("[native] write failed: {error}");
            break;
        }
    }
}

fn handle_request(
    request: Request,
    settings: &mut Settings,
    settings_configured: &mut bool,
) -> Response {
    match request.method.as_str() {
        "agent.health" => ok(
            request.id,
            json!({
                "ok": true,
                "service": SERVICE_NAME,
                "version": VERSION,
                "pid": process::id()
            }),
        ),
        "agent.echo" => ok(request.id, json!({ "echo": request.params })),
        "settings.get" => ok(request.id, settings_json(settings, *settings_configured)),
        "settings.set" => {
            if let Some(workspace_dir) = request.params.get("workspace_dir").and_then(Value::as_str)
            {
                settings.workspace_dir = workspace_dir.to_string();
            }
            if let Some(mcp_url) = request.params.get("mcp_url").and_then(Value::as_str) {
                settings.mcp_url = mcp_url.to_string();
            }
            if let Some(model_base_url) =
                request.params.get("model_base_url").and_then(Value::as_str)
            {
                settings.model_base_url = model_base_url.to_string();
            }
            if let Some(model_name) = request.params.get("model_name").and_then(Value::as_str) {
                settings.model_name = model_name.to_string();
            }
            if let Some(model_api_type) =
                request.params.get("model_api_type").and_then(Value::as_str)
            {
                settings.model_api_type = model_api_type.to_string();
            }
            if let Some(api_key) = request.params.get("api_key").and_then(Value::as_str) {
                settings.api_key = api_key.to_string();
            }
            if let Some(temperature) = request.params.get("temperature").and_then(Value::as_f64) {
                settings.temperature = temperature;
            }
            match save_settings(settings) {
                Ok(()) => *settings_configured = true,
                Err(error) => eprintln!("[native] failed to save settings: {error}"),
            }
            ok(request.id, settings_json(settings, *settings_configured))
        }
        "workspace.set" => {
            if let Some(workspace_dir) = request.params.get("workspace_dir").and_then(Value::as_str)
            {
                settings.workspace_dir = workspace_dir.to_string();
                match save_settings(settings) {
                    Ok(()) => *settings_configured = true,
                    Err(error) => eprintln!("[native] failed to save settings: {error}"),
                }
                ok(request.id, settings_json(settings, *settings_configured))
            } else {
                err(request.id, "invalid_params", "workspace_dir is required")
            }
        }
        "agent.run" => match prepare_llm_tools(settings) {
            Ok(prepared) => ok(
                request.id,
                json!({
                    "accepted": true,
                    "message": "LLM execution is not wired yet; MCP tools were prepared.",
                    "llm_tool_count": prepared.llm_tools.len(),
                    "mcp_tool_count": prepared.mcp_tools.len(),
                    "tools": prepared.llm_tools,
                    "tool_name_map": prepared.tool_name_map,
                }),
            ),
            Err(error) => err(request.id, "mcp_tools_failed", &error),
        },
        "agent.tools" | "llm.tools" => match prepare_llm_tools(settings) {
            Ok(prepared) => ok(
                request.id,
                json!({
                    "llm_tool_count": prepared.llm_tools.len(),
                    "mcp_tool_count": prepared.mcp_tools.len(),
                    "tools": prepared.llm_tools,
                    "tool_name_map": prepared.tool_name_map,
                }),
            ),
            Err(error) => err(request.id, "mcp_tools_failed", &error),
        },
        "agent.cancel" | "agent.reset" => ok(request.id, json!({ "ok": true })),
        "tabs.list" => ok(request.id, json!({ "tabs": [] })),
        "tabs.active" => ok(request.id, json!({ "active_tab": null })),
        _ => err(request.id, "unknown_method", "Unknown method"),
    }
}

fn settings_json(settings: &Settings, configured: bool) -> Value {
    json!({
        "configured": configured,
        "workspace_dir": settings.workspace_dir,
        "mcp_url": settings.mcp_url,
        "model_base_url": settings.model_base_url,
        "model_name": settings.model_name,
        "model_api_type": normalize_model_api_type(&settings.model_api_type),
        "api_key": settings.api_key,
        "temperature": settings.temperature
    })
}

fn load_settings() -> (Settings, bool) {
    let Some(path) = settings_path() else {
        return (Settings::default(), false);
    };
    let Ok(text) = fs::read_to_string(path) else {
        return (Settings::default(), false);
    };
    match serde_json::from_str::<Settings>(&text) {
        Ok(mut settings) => {
            settings.model_api_type = normalize_model_api_type(&settings.model_api_type);
            (settings, true)
        }
        Err(error) => {
            eprintln!("[native] failed to parse settings, using defaults: {error}");
            (Settings::default(), false)
        }
    }
}

fn normalize_model_api_type(value: &str) -> String {
    match value {
        "anthropic" => "anthropic".to_string(),
        _ => "openai".to_string(),
    }
}

fn save_settings(settings: &Settings) -> io::Result<()> {
    let Some(path) = settings_path() else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("failed to encode settings: {error}"),
        )
    })?;
    fs::write(path, text)
}

fn settings_path() -> Option<PathBuf> {
    let base = env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(PathBuf::from))?;
    Some(base.join("BrosdkAssistant").join("settings.json"))
}

#[derive(Debug)]
struct PreparedTools {
    mcp_tools: Vec<Value>,
    llm_tools: Vec<Value>,
    tool_name_map: HashMap<String, String>,
}

fn prepare_llm_tools(settings: &Settings) -> Result<PreparedTools, String> {
    let mut mcp = McpHttpClient::new(settings.mcp_url.clone())?;
    mcp.connect()?;
    let mcp_tools = mcp.list_tools()?;
    let tool_name_map = build_openai_tool_name_map(&mcp_tools)?;
    let llm_tools = mcp_tools_to_openai(&mcp_tools, &tool_name_map)?;
    mcp.close();
    Ok(PreparedTools {
        mcp_tools,
        llm_tools,
        tool_name_map,
    })
}

impl McpHttpClient {
    fn new(url: String) -> Result<Self, String> {
        let http = Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|error| format!("failed to create MCP HTTP client: {error}"))?;
        Ok(Self {
            url,
            http,
            next_id: 0,
            session_id: None,
        })
    }

    fn connect(&mut self) -> Result<(), String> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {
                    "name": SERVICE_NAME,
                    "version": VERSION
                }
            }),
            false,
        )?;
        self.notify("notifications/initialized", json!({}))?;
        Ok(())
    }

    fn close(&mut self) {
        let Some(session_id) = self.session_id.clone() else {
            return;
        };
        let _ = self
            .http
            .delete(&self.url)
            .header("mcp-session-id", session_id)
            .send();
    }

    fn list_tools(&mut self) -> Result<Vec<Value>, String> {
        let result = self.request("tools/list", json!({}), true)?;
        let tools = result
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(tools)
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let response = self
            .http
            .post(&self.url)
            .headers(self.headers(true)?)
            .json(&payload)
            .send()
            .map_err(|error| format!("MCP notify {method} failed: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "MCP notify {method} returned HTTP {}",
                response.status()
            ));
        }
        Ok(())
    }

    fn request(
        &mut self,
        method: &str,
        params: Value,
        include_session: bool,
    ) -> Result<Value, String> {
        self.next_id += 1;
        let payload = json!({
            "jsonrpc": "2.0",
            "id": self.next_id,
            "method": method,
            "params": params,
        });

        let response = self
            .http
            .post(&self.url)
            .headers(self.headers(include_session)?)
            .json(&payload)
            .send()
            .map_err(|error| format!("MCP request {method} failed: {error}"))?;

        if let Some(session_id) = response.headers().get("mcp-session-id") {
            if let Ok(session_id) = session_id.to_str() {
                self.session_id = Some(session_id.to_string());
            }
        }

        if !response.status().is_success() {
            return Err(format!(
                "MCP request {method} returned HTTP {}",
                response.status()
            ));
        }

        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let body = response
            .text()
            .map_err(|error| format!("failed to read MCP response body: {error}"))?;
        if body.trim().is_empty() {
            return Ok(json!({}));
        }

        let message = if content_type.contains("text/event-stream") {
            parse_sse_response(&body)?
        } else {
            serde_json::from_str::<Value>(&body)
                .map_err(|error| format!("invalid MCP JSON response: {error}"))?
        };

        if let Some(error) = message.get("error") {
            let error_message = error
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| error.to_string());
            return Err(format!("MCP request {method} failed: {error_message}"));
        }

        Ok(message.get("result").cloned().unwrap_or_else(|| json!({})))
    }

    fn headers(&self, include_session: bool) -> Result<HeaderMap, String> {
        let mut headers = HeaderMap::new();
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/json, text/event-stream"),
        );
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if include_session {
            if let Some(session_id) = &self.session_id {
                headers.insert(
                    "mcp-session-id",
                    HeaderValue::from_str(session_id)
                        .map_err(|error| format!("invalid MCP session id: {error}"))?,
                );
            }
        }
        Ok(headers)
    }
}

fn parse_sse_response(text: &str) -> Result<Value, String> {
    let mut data_lines = Vec::new();
    for raw_line in text.lines() {
        let line = raw_line.trim_end_matches('\r');
        if let Some(data) = line.strip_prefix("data:") {
            data_lines.push(data.trim().to_string());
        } else if line.is_empty() && !data_lines.is_empty() {
            break;
        }
    }
    if data_lines.is_empty() {
        return Err("MCP SSE response contained no data event".to_string());
    }
    serde_json::from_str(&data_lines.join("\n"))
        .map_err(|error| format!("invalid MCP SSE JSON data: {error}"))
}

fn build_openai_tool_name_map(tools: &[Value]) -> Result<HashMap<String, String>, String> {
    let mut mapped = HashMap::new();
    let mut used = HashSet::new();

    for tool in tools {
        let original_name = tool
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| "MCP tool is missing a string name".to_string())?
            .to_string();
        let mut safe_name = safe_openai_tool_name(&original_name);
        if used.contains(&safe_name) {
            let digest = sha1_hex_prefix(&original_name, 8);
            let mut counter = 2;
            loop {
                let suffix = format!("_{digest}_{counter}");
                let base_len = OPENAI_TOOL_NAME_MAX_LENGTH.saturating_sub(suffix.len());
                let base = trim_trailing_underscores(&safe_name[..safe_name.len().min(base_len)]);
                safe_name = format!("{}{}", if base.is_empty() { "tool" } else { base }, suffix);
                if !used.contains(&safe_name) {
                    break;
                }
                counter += 1;
            }
        }
        used.insert(safe_name.clone());
        mapped.insert(safe_name, original_name);
    }

    Ok(mapped)
}

fn mcp_tools_to_openai(
    tools: &[Value],
    name_map: &HashMap<String, String>,
) -> Result<Vec<Value>, String> {
    let original_to_safe: HashMap<&str, &str> = name_map
        .iter()
        .map(|(safe, original)| (original.as_str(), safe.as_str()))
        .collect();
    let mut converted = Vec::with_capacity(tools.len());

    for tool in tools {
        let original_name = tool
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| "MCP tool is missing a string name".to_string())?;
        let safe_name = original_to_safe
            .get(original_name)
            .ok_or_else(|| format!("missing safe name for MCP tool {original_name}"))?;
        let description = tool
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let parameters = tool
            .get("inputSchema")
            .cloned()
            .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
        converted.push(json!({
            "type": "function",
            "function": {
                "name": safe_name,
                "description": description,
                "parameters": parameters
            }
        }));
    }

    Ok(converted)
}

fn safe_openai_tool_name(name: &str) -> String {
    let mut safe: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    safe = trim_surrounding_underscores(&safe).to_string();
    if safe.is_empty() {
        safe = "tool".to_string();
    }

    if safe == name && safe.len() <= OPENAI_TOOL_NAME_MAX_LENGTH {
        return safe;
    }

    let digest = sha1_hex_prefix(name, 8);
    let suffix = format!("_{digest}");
    let base_len = OPENAI_TOOL_NAME_MAX_LENGTH.saturating_sub(suffix.len());
    let base = trim_trailing_underscores(&safe[..safe.len().min(base_len)]);
    format!("{}{}", if base.is_empty() { "tool" } else { base }, suffix)
}

fn sha1_hex_prefix(value: &str, len: usize) -> String {
    let digest = Sha1::digest(value.as_bytes());
    let hex = format!("{digest:x}");
    hex.chars().take(len).collect()
}

fn trim_surrounding_underscores(value: &str) -> &str {
    trim_trailing_underscores(value.trim_start_matches('_'))
}

fn trim_trailing_underscores(value: &str) -> &str {
    value.trim_end_matches('_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_tool_names_keep_valid_names() {
        assert_eq!(safe_openai_tool_name("tabs"), "tabs");
        assert_eq!(safe_openai_tool_name("local_read-file"), "local_read-file");
    }

    #[test]
    fn safe_tool_names_replace_invalid_characters() {
        let safe = safe_openai_tool_name("browser/tabs.active");
        assert!(safe.starts_with("browser_tabs_active_"));
        assert!(safe.len() <= OPENAI_TOOL_NAME_MAX_LENGTH);
        assert!(
            safe.chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        );
    }

    #[test]
    fn converts_mcp_tools_to_openai_tools() {
        let mcp_tools = vec![json!({
            "name": "browser/tabs.active",
            "description": "Read active tab",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "page": { "type": "number" }
                }
            }
        })];
        let name_map = build_openai_tool_name_map(&mcp_tools).expect("name map");
        let openai_tools = mcp_tools_to_openai(&mcp_tools, &name_map).expect("openai tools");

        assert_eq!(openai_tools.len(), 1);
        assert_eq!(openai_tools[0]["type"], "function");
        assert_eq!(
            openai_tools[0]["function"]["description"],
            "Read active tab"
        );
        assert_eq!(
            openai_tools[0]["function"]["parameters"]["properties"]["page"]["type"],
            "number"
        );
        let safe_name = openai_tools[0]["function"]["name"].as_str().unwrap();
        assert_eq!(name_map.get(safe_name).unwrap(), "browser/tabs.active");
    }
}

fn ok(id: String, result: Value) -> Response {
    Response {
        id,
        result: Some(result),
        error: None,
    }
}

fn err(id: String, code: &str, message: &str) -> Response {
    Response {
        id,
        result: None,
        error: Some(ErrorBody {
            code: code.to_string(),
            message: message.to_string(),
        }),
    }
}

fn read_message() -> io::Result<Option<Value>> {
    let mut length_bytes = [0_u8; 4];
    match io::stdin().read_exact(&mut length_bytes) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }

    let length = u32::from_le_bytes(length_bytes) as usize;
    if length > MAX_INBOUND_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("message too large: {length} bytes"),
        ));
    }

    let mut buffer = vec![0_u8; length];
    io::stdin().read_exact(&mut buffer)?;
    let value = serde_json::from_slice(&buffer).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid JSON payload: {error}"),
        )
    })?;
    Ok(Some(value))
}

fn write_response(response: &Response) -> io::Result<()> {
    let value = serde_json::to_value(response).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("failed to encode response: {error}"),
        )
    })?;
    write_message(&value)
}

fn write_message(value: &Value) -> io::Result<()> {
    let payload = serde_json::to_vec(value).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("failed to encode JSON: {error}"),
        )
    })?;
    let length = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "outbound message is too large"))?;

    let mut stdout = io::stdout().lock();
    stdout.write_all(&length.to_le_bytes())?;
    stdout.write_all(&payload)?;
    stdout.flush()
}
