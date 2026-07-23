use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderMap, HeaderValue};
use serde_json::{Value, json};

const SERVICE_NAME: &str = "brosdk-assistant-native";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Debug)]
pub(crate) struct McpHttpClient {
    url: String,
    http: Client,
    next_id: u64,
    session_id: Option<String>,
}

impl McpHttpClient {
    pub(crate) fn new(url: String) -> Result<Self, String> {
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

    pub(crate) fn connect(&mut self) -> Result<(), String> {
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

    pub(crate) fn close(&mut self) {
        let Some(session_id) = self.session_id.clone() else {
            return;
        };
        let _ = self
            .http
            .delete(&self.url)
            .header("mcp-session-id", session_id)
            .send();
    }

    pub(crate) fn list_tools(&mut self) -> Result<Vec<Value>, String> {
        let result = self.request("tools/list", json!({}), true)?;
        let tools = result
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(tools)
    }

    pub(crate) fn call_tool(&mut self, name: &str, arguments: Value) -> Result<Value, String> {
        self.request(
            "tools/call",
            json!({
                "name": name,
                "arguments": arguments,
            }),
            true,
        )
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

        if let Some(session_id) = response.headers().get("mcp-session-id")
            && let Ok(session_id) = session_id.to_str()
        {
            self.session_id = Some(session_id.to_string());
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
        if include_session && let Some(session_id) = &self.session_id {
            headers.insert(
                "mcp-session-id",
                HeaderValue::from_str(session_id)
                    .map_err(|error| format!("invalid MCP session id: {error}"))?,
            );
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
