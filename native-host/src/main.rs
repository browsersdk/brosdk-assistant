use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::env;
use std::io::{self, Read, Write};
use std::process;

const SERVICE_NAME: &str = "brosdk-assistant-native";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_INBOUND_BYTES: usize = 16 * 1024 * 1024;

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

#[derive(Debug, Clone)]
struct Settings {
    workspace_dir: String,
    model: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            workspace_dir: env::current_dir()
                .ok()
                .map(|path| path.display().to_string())
                .unwrap_or_default(),
            model: "not-configured".to_string(),
        }
    }
}

fn main() {
    let mut settings = Settings::default();
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

        let response = handle_request(request, &mut settings);
        if let Err(error) = write_response(&response) {
            eprintln!("[native] write failed: {error}");
            break;
        }
    }
}

fn handle_request(request: Request, settings: &mut Settings) -> Response {
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
        "settings.get" => ok(request.id, settings_json(settings)),
        "settings.set" => {
            if let Some(workspace_dir) = request.params.get("workspace_dir").and_then(Value::as_str)
            {
                settings.workspace_dir = workspace_dir.to_string();
            }
            if let Some(model) = request.params.get("model").and_then(Value::as_str) {
                settings.model = model.to_string();
            }
            ok(request.id, settings_json(settings))
        }
        "workspace.set" => {
            if let Some(workspace_dir) = request.params.get("workspace_dir").and_then(Value::as_str)
            {
                settings.workspace_dir = workspace_dir.to_string();
                ok(request.id, settings_json(settings))
            } else {
                err(request.id, "invalid_params", "workspace_dir is required")
            }
        }
        "agent.run" => ok(
            request.id,
            json!({
                "accepted": true,
                "message": "agent.run is stubbed in milestone 1"
            }),
        ),
        "agent.cancel" | "agent.reset" => ok(request.id, json!({ "ok": true })),
        "tabs.list" => ok(request.id, json!({ "tabs": [] })),
        "tabs.active" => ok(request.id, json!({ "active_tab": null })),
        _ => err(request.id, "unknown_method", "Unknown method"),
    }
}

fn settings_json(settings: &Settings) -> Value {
    json!({
        "workspace_dir": settings.workspace_dir,
        "model": settings.model
    })
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
