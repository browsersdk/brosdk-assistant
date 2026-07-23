use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

const MAX_INBOUND_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub(crate) struct Request {
    pub(crate) id: String,
    pub(crate) method: String,
    #[serde(default)]
    pub(crate) params: Value,
}

#[derive(Debug, Serialize)]
pub(crate) struct Response {
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

#[derive(Clone)]
pub(crate) struct HostBridge {
    outbound: Sender<Value>,
    extension_waiters: Arc<Mutex<HashMap<String, Sender<Value>>>>,
}

impl HostBridge {
    pub(crate) fn new(outbound: Sender<Value>) -> Self {
        Self {
            outbound,
            extension_waiters: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub(crate) fn send(&self, value: Value) -> Result<(), String> {
        self.outbound
            .send(value)
            .map_err(|_| "native output channel is closed".to_string())
    }

    pub(crate) fn send_response(&self, response: Response) -> Result<(), String> {
        let value = serde_json::to_value(response)
            .map_err(|error| format!("failed to encode response: {error}"))?;
        self.send(value)
    }

    pub(crate) fn send_event(&self, event: &str, payload: Value) -> Result<(), String> {
        self.send(json!({ "event": event, "payload": payload }))
    }

    pub(crate) fn register_extension_waiter(&self, id: String) -> Result<Receiver<Value>, String> {
        let (sender, receiver) = mpsc::channel();
        self.extension_waiters
            .lock()
            .map_err(|_| "failed to access extension tool waiters".to_string())?
            .insert(id, sender);
        Ok(receiver)
    }

    pub(crate) fn remove_extension_waiter(&self, id: &str) {
        if let Ok(mut waiters) = self.extension_waiters.lock() {
            waiters.remove(id);
        }
    }

    pub(crate) fn route_extension_response(&self, message: &Value) -> bool {
        let Some(id) = message.get("id").and_then(Value::as_str) else {
            return false;
        };
        let waiter = self
            .extension_waiters
            .lock()
            .ok()
            .and_then(|mut waiters| waiters.remove(id));
        if let Some(waiter) = waiter {
            let _ = waiter.send(message.clone());
            return true;
        }
        false
    }
}

pub(crate) fn start_stdout_bridge() -> HostBridge {
    let (outbound, output) = mpsc::channel::<Value>();
    thread::spawn(move || {
        for value in output {
            if let Err(error) = write_message(&value) {
                eprintln!("[native] write failed: {error}");
                break;
            }
        }
    });
    HostBridge::new(outbound)
}

pub(crate) fn ok(id: String, result: Value) -> Response {
    Response {
        id,
        result: Some(result),
        error: None,
    }
}

pub(crate) fn err(id: String, code: &str, message: &str) -> Response {
    Response {
        id,
        result: None,
        error: Some(ErrorBody {
            code: code.to_string(),
            message: message.to_string(),
        }),
    }
}

pub(crate) fn read_message() -> io::Result<Option<Value>> {
    read_message_from(&mut io::stdin())
}

fn read_message_from(reader: &mut impl Read) -> io::Result<Option<Value>> {
    let mut length_bytes = [0_u8; 4];
    match reader.read_exact(&mut length_bytes) {
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
    reader.read_exact(&mut buffer)?;
    let value = serde_json::from_slice(&buffer).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid JSON payload: {error}"),
        )
    })?;
    Ok(Some(value))
}

fn write_message(value: &Value) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    write_message_to(&mut stdout, value)
}

fn write_message_to(writer: &mut impl Write, value: &Value) -> io::Result<()> {
    let payload = serde_json::to_vec(value).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("failed to encode JSON: {error}"),
        )
    })?;
    let length = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "outbound message is too large"))?;
    writer.write_all(&length.to_le_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn native_message_framing_round_trips_json() {
        let expected = json!({ "method": "agent.health", "params": { "ok": true } });
        let mut encoded = Vec::new();
        write_message_to(&mut encoded, &expected).unwrap();

        let mut reader = Cursor::new(encoded);
        assert_eq!(read_message_from(&mut reader).unwrap(), Some(expected));
        assert_eq!(read_message_from(&mut reader).unwrap(), None);
    }

    #[test]
    fn native_message_framing_rejects_oversized_input() {
        let mut encoded = Cursor::new(((MAX_INBOUND_BYTES as u32) + 1).to_le_bytes());
        let error = read_message_from(&mut encoded).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn extension_tool_responses_are_routed_to_the_registered_waiter() {
        let (outbound, _output) = mpsc::channel();
        let bridge = HostBridge::new(outbound);
        let receiver = bridge
            .register_extension_waiter("ext-tool-test".to_string())
            .unwrap();
        let message = json!({ "id": "ext-tool-test", "result": { "ok": true } });

        assert!(bridge.route_extension_response(&message));
        assert_eq!(receiver.recv().unwrap(), message);
        assert!(!bridge.route_extension_response(&message));
    }
}
