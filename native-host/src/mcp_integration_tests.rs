use super::tools::mcp::McpHttpClient;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug)]
struct RecordedRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Value,
}

struct MockResponse {
    status: &'static str,
    content_type: &'static str,
    headers: Vec<(&'static str, &'static str)>,
    body: String,
}

impl MockResponse {
    fn json(body: Value) -> Self {
        Self {
            status: "200 OK",
            content_type: "application/json",
            headers: Vec::new(),
            body: body.to_string(),
        }
    }

    fn json_with_session(body: Value) -> Self {
        Self {
            headers: vec![("mcp-session-id", "session-test")],
            ..Self::json(body)
        }
    }

    fn sse(body: Value) -> Self {
        Self {
            status: "200 OK",
            content_type: "text/event-stream",
            headers: Vec::new(),
            body: format!("data: {body}\n\n"),
        }
    }

    fn empty() -> Self {
        Self {
            status: "200 OK",
            content_type: "application/json",
            headers: Vec::new(),
            body: String::new(),
        }
    }

    fn server_error() -> Self {
        Self {
            status: "500 Internal Server Error",
            content_type: "application/json",
            headers: Vec::new(),
            body: json!({ "error": "failed" }).to_string(),
        }
    }
}

#[test]
fn mcp_initializes_discovers_invokes_and_closes_with_session() {
    let (url, requests, server) = start_mock_server(vec![
        MockResponse::json_with_session(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "protocolVersion": "2025-06-18",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "mock-mcp", "version": "1.0" }
            }
        })),
        MockResponse::empty(),
        MockResponse::sse(json!({
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "tools": [{
                    "name": "mock_read",
                    "description": "Read mock data",
                    "inputSchema": {
                        "type": "object",
                        "properties": { "query": { "type": "string" } }
                    }
                }]
            }
        })),
        MockResponse::json(json!({
            "jsonrpc": "2.0",
            "id": 3,
            "result": {
                "content": [{ "type": "text", "text": "mock result" }]
            }
        })),
        MockResponse::empty(),
    ]);

    let mut client = McpHttpClient::new(url).unwrap();
    client.connect().unwrap();
    let tools = client.list_tools().unwrap();
    assert_eq!(tools[0]["name"], "mock_read");
    let result = client
        .call_tool("mock_read", json!({ "query": "hello" }))
        .unwrap();
    assert_eq!(result["content"][0]["text"], "mock result");
    client.close();
    server.join().unwrap();

    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 5);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(requests[0].path, "/mcp");
    assert_eq!(requests[0].body["method"], "initialize");
    assert!(!requests[0].headers.contains_key("mcp-session-id"));
    assert_eq!(requests[1].body["method"], "notifications/initialized");
    assert_eq!(requests[2].body["method"], "tools/list");
    assert_eq!(requests[3].body["method"], "tools/call");
    assert_eq!(requests[3].body["params"]["name"], "mock_read");
    assert_eq!(requests[3].body["params"]["arguments"]["query"], "hello");
    assert_eq!(requests[4].method, "DELETE");
    for request in &requests[1..] {
        assert_eq!(
            request.headers.get("mcp-session-id").map(String::as_str),
            Some("session-test")
        );
    }
}

#[test]
fn mcp_surfaces_json_rpc_tool_errors() {
    let (url, _requests, server) = start_mock_server(vec![
        MockResponse::json_with_session(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": { "protocolVersion": "2025-06-18", "capabilities": {} }
        })),
        MockResponse::empty(),
        MockResponse::json(json!({
            "jsonrpc": "2.0",
            "id": 2,
            "error": { "code": -32000, "message": "tool exploded" }
        })),
        MockResponse::empty(),
    ]);

    let mut client = McpHttpClient::new(url).unwrap();
    client.connect().unwrap();
    let error = client
        .call_tool("broken_tool", json!({}))
        .expect_err("JSON-RPC tool error should be returned");
    assert!(error.contains("tool exploded"));
    client.close();
    server.join().unwrap();
}

#[test]
fn mcp_surfaces_initialize_http_errors() {
    let (url, requests, server) = start_mock_server(vec![MockResponse::server_error()]);
    let mut client = McpHttpClient::new(url).unwrap();
    let error = client
        .connect()
        .expect_err("initialize HTTP error should fail connection");
    assert!(error.contains("initialize returned HTTP 500"));
    server.join().unwrap();
    assert_eq!(requests.lock().unwrap().len(), 1);
}

fn start_mock_server(
    responses: Vec<MockResponse>,
) -> (
    String,
    Arc<Mutex<Vec<RecordedRequest>>>,
    thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let server_requests = requests.clone();
    let server = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        for response in responses {
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(connection) => break connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "mock MCP request timed out");
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("mock MCP accept failed: {error}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let request = read_http_request(&mut stream);
            server_requests.lock().unwrap().push(request);
            write_http_response(&mut stream, response);
        }
    });
    (format!("http://{address}/mcp"), requests, server)
}

fn read_http_request(stream: &mut TcpStream) -> RecordedRequest {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut chunk).unwrap();
        assert!(read > 0, "connection closed before HTTP headers");
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(index) = find_bytes(&bytes, b"\r\n\r\n") {
            break index + 4;
        }
    };
    let header_text = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().unwrap();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap().to_string();
    let path = request_parts.next().unwrap().to_string();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect::<HashMap<_, _>>();
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    while bytes.len() < header_end + content_length {
        let read = stream.read(&mut chunk).unwrap();
        assert!(read > 0, "connection closed before HTTP body");
        bytes.extend_from_slice(&chunk[..read]);
    }
    let body_bytes = &bytes[header_end..header_end + content_length];
    let body = if body_bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(body_bytes).unwrap()
    };
    RecordedRequest {
        method,
        path,
        headers,
        body,
    }
}

fn write_http_response(stream: &mut TcpStream, response: MockResponse) {
    let mut headers = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        response.status,
        response.content_type,
        response.body.len()
    );
    for (name, value) in response.headers {
        headers.push_str(&format!("{name}: {value}\r\n"));
    }
    headers.push_str("\r\n");
    stream.write_all(headers.as_bytes()).unwrap();
    stream.write_all(response.body.as_bytes()).unwrap();
    stream.flush().unwrap();
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
