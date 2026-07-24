use crate::protocol::{HostBridge, Request, err, ok};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::process;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(120);
const CONFIRMATION_POLL_INTERVAL: Duration = Duration::from_millis(100);
static NEXT_CONFIRMATION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConfirmationDecision {
    Approved,
    Denied,
}

impl ConfirmationDecision {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Approved => "approved",
            Self::Denied => "denied",
        }
    }
}

struct PendingConfirmation {
    run_id: String,
    client_id: Option<String>,
    sender: Sender<ConfirmationDecision>,
}

#[derive(Clone, Default)]
pub(crate) struct ConfirmationRegistry {
    pending: Arc<Mutex<HashMap<String, PendingConfirmation>>>,
}

pub(crate) struct ConfirmationRequest<'a> {
    pub(crate) run_id: &'a str,
    pub(crate) conversation_id: &'a str,
    pub(crate) client_id: Option<&'a str>,
    pub(crate) tool_call_id: &'a str,
    pub(crate) tool_name: &'a str,
    pub(crate) summary: &'a str,
    pub(crate) arguments: Value,
}

impl ConfirmationRegistry {
    pub(crate) fn request(
        &self,
        bridge: &HostBridge,
        cancelled: &AtomicBool,
        request: ConfirmationRequest<'_>,
    ) -> Result<ConfirmationDecision, String> {
        let confirmation_id = format!(
            "confirmation-{}-{}",
            process::id(),
            NEXT_CONFIRMATION_ID.fetch_add(1, Ordering::Relaxed)
        );
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| "failed to access pending confirmations".to_string())?
            .insert(
                confirmation_id.clone(),
                PendingConfirmation {
                    run_id: request.run_id.to_string(),
                    client_id: request.client_id.map(str::to_string),
                    sender,
                },
            );

        let event = json!({
            "run_id": request.run_id,
            "conversation_id": request.conversation_id,
            "client_id": request.client_id,
            "confirmation_id": confirmation_id,
            "tool_call_id": request.tool_call_id,
            "tool_name": request.tool_name,
            "summary": request.summary,
            "arguments": request.arguments,
            "expires_in_ms": CONFIRMATION_TIMEOUT.as_millis(),
        });
        if let Err(error) = bridge.send_event("agent.confirmation.request", event) {
            self.remove(&confirmation_id);
            return Err(error);
        }

        let deadline = Instant::now() + CONFIRMATION_TIMEOUT;
        loop {
            if cancelled.load(Ordering::SeqCst) {
                self.remove(&confirmation_id);
                return Err("run cancelled".to_string());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.remove(&confirmation_id);
                return Err(format!(
                    "confirmation timed out for tool {}",
                    request.tool_name
                ));
            }
            match receiver.recv_timeout(remaining.min(CONFIRMATION_POLL_INTERVAL)) {
                Ok(decision) => return Ok(decision),
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => {
                    self.remove(&confirmation_id);
                    return Err("confirmation response channel closed".to_string());
                }
            }
        }
    }

    fn remove(&self, confirmation_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(confirmation_id);
        }
    }
}

pub(crate) fn resolve_confirmation(
    request: Request,
    bridge: &HostBridge,
    confirmations: &ConfirmationRegistry,
) {
    let Some(confirmation_id) = request
        .params
        .get("confirmation_id")
        .and_then(Value::as_str)
    else {
        let _ = bridge.send_response(err(
            request.id,
            "invalid_params",
            "confirmation_id is required",
        ));
        return;
    };
    let Some(run_id) = request.params.get("run_id").and_then(Value::as_str) else {
        let _ = bridge.send_response(err(request.id, "invalid_params", "run_id is required"));
        return;
    };
    let Some(approved) = request.params.get("approved").and_then(Value::as_bool) else {
        let _ = bridge.send_response(err(
            request.id,
            "invalid_params",
            "approved must be a boolean",
        ));
        return;
    };
    let client_id = request.params.get("client_id").and_then(Value::as_str);

    let pending = confirmations.pending.lock().ok().and_then(|mut pending| {
        let matches = pending.get(confirmation_id).is_some_and(|item| {
            item.run_id == run_id
                && item
                    .client_id
                    .as_deref()
                    .is_none_or(|expected| Some(expected) == client_id)
        });
        matches.then(|| pending.remove(confirmation_id)).flatten()
    });
    let Some(pending) = pending else {
        let _ = bridge.send_response(err(
            request.id,
            "confirmation_not_found",
            "confirmation was not found, expired, or belongs to another run",
        ));
        return;
    };
    let decision = if approved {
        ConfirmationDecision::Approved
    } else {
        ConfirmationDecision::Denied
    };
    if pending.sender.send(decision).is_err() {
        let _ = bridge.send_response(err(
            request.id,
            "confirmation_expired",
            "confirmation is no longer waiting for a decision",
        ));
        return;
    }
    let _ = bridge.send_response(ok(
        request.id,
        json!({
            "confirmation_id": confirmation_id,
            "run_id": run_id,
            "decision": decision.as_str(),
        }),
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::HostBridge;
    use std::sync::mpsc;
    use std::thread;

    #[test]
    fn confirmation_is_bound_to_run_and_client() {
        let registry = ConfirmationRegistry::default();
        let worker_registry = registry.clone();
        let (outbound, output) = mpsc::channel();
        let bridge = HostBridge::new(outbound);
        let worker_bridge = bridge.clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = cancelled.clone();
        let worker = thread::spawn(move || {
            worker_registry.request(
                &worker_bridge,
                worker_cancelled.as_ref(),
                ConfirmationRequest {
                    run_id: "run-1",
                    conversation_id: "conversation-1",
                    client_id: Some("client-1"),
                    tool_call_id: "call-1",
                    tool_name: "browser_click",
                    summary: "Click Submit",
                    arguments: json!({ "ref": "t1-r1-e1" }),
                },
            )
        });
        let event = output.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(event["event"], "agent.confirmation.request");
        let confirmation_id = event["payload"]["confirmation_id"]
            .as_str()
            .unwrap()
            .to_string();

        resolve_confirmation(
            Request {
                id: "wrong-client".to_string(),
                method: "agent.confirm".to_string(),
                params: json!({
                    "confirmation_id": confirmation_id,
                    "run_id": "run-1",
                    "client_id": "client-2",
                    "approved": true,
                }),
            },
            &bridge,
            &registry,
        );
        let response = output.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(response["error"]["code"], "confirmation_not_found");

        resolve_confirmation(
            Request {
                id: "approve".to_string(),
                method: "agent.confirm".to_string(),
                params: json!({
                    "confirmation_id": confirmation_id,
                    "run_id": "run-1",
                    "client_id": "client-1",
                    "approved": true,
                }),
            },
            &bridge,
            &registry,
        );
        let response = output.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(response["result"]["decision"], "approved");
        assert_eq!(
            worker.join().unwrap().unwrap(),
            ConfirmationDecision::Approved
        );
    }
}
