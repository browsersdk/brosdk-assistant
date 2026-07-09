use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::PathBuf;
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

impl Default for Settings {
    fn default() -> Self {
        Self {
            workspace_dir: env::current_dir()
                .ok()
                .map(|path| path.display().to_string())
                .unwrap_or_default(),
            mcp_url: "http://127.0.0.1:3000/mcp".to_string(),
            model_base_url: "https://api.deepseek.com".to_string(),
            model_name: "deepseek-v4-flash".to_string(),
            model_api_type: "openai-compatible".to_string(),
            api_key: String::new(),
            temperature: 0.0,
        }
    }
}

fn main() {
    let mut settings = load_settings();
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
            if let Err(error) = save_settings(settings) {
                eprintln!("[native] failed to save settings: {error}");
            }
            ok(request.id, settings_json(settings))
        }
        "workspace.set" => {
            if let Some(workspace_dir) = request.params.get("workspace_dir").and_then(Value::as_str)
            {
                settings.workspace_dir = workspace_dir.to_string();
                if let Err(error) = save_settings(settings) {
                    eprintln!("[native] failed to save settings: {error}");
                }
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
        "mcp_url": settings.mcp_url,
        "model_base_url": settings.model_base_url,
        "model_name": settings.model_name,
        "model_api_type": settings.model_api_type,
        "api_key": settings.api_key,
        "temperature": settings.temperature
    })
}

fn load_settings() -> Settings {
    let Some(path) = settings_path() else {
        return Settings::default();
    };
    let Ok(text) = fs::read_to_string(path) else {
        return Settings::default();
    };
    serde_json::from_str(&text).unwrap_or_else(|error| {
        eprintln!("[native] failed to parse settings, using defaults: {error}");
        Settings::default()
    })
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
