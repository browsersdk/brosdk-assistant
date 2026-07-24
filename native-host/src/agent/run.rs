use super::confirmation::{ConfirmationDecision, ConfirmationRegistry, ConfirmationRequest};
use crate::protocol::{HostBridge, Request, err, ok};
use crate::{Settings, run_agent, settings_from_params};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::process;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

pub(crate) const MAX_HISTORY_MESSAGES: usize = 24;
pub(crate) const MAX_HISTORY_BYTES: usize = 64 * 1024;
const MAX_CONVERSATIONS: usize = 50;
static NEXT_RUN_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_CONVERSATION_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_CONVERSATION_UPDATE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Default)]
pub(crate) struct RunRegistry {
    active: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

#[derive(Clone, Default)]
pub(crate) struct ConversationRegistry {
    conversations: Arc<Mutex<HashMap<String, Conversation>>>,
}

#[derive(Debug, Default)]
struct Conversation {
    messages: Vec<Value>,
    updated_at: u64,
}

#[derive(Clone)]
pub(crate) struct RunContext {
    run_id: String,
    conversation_id: String,
    client_id: Option<String>,
    cancelled: Arc<AtomicBool>,
    bridge: HostBridge,
    confirmations: ConfirmationRegistry,
}

impl RunContext {
    pub(crate) fn run_id(&self) -> &str {
        &self.run_id
    }

    pub(crate) fn cancellation_flag(&self) -> &AtomicBool {
        self.cancelled.as_ref()
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub(crate) fn ensure_active(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err("run cancelled".to_string())
        } else {
            Ok(())
        }
    }

    pub(crate) fn emit(&self, event: &str, mut payload: Value) {
        if !self.is_cancelled() {
            if let Value::Object(fields) = &mut payload {
                fields.insert("run_id".to_string(), json!(self.run_id));
                fields.insert("conversation_id".to_string(), json!(self.conversation_id));
                if let Some(client_id) = &self.client_id {
                    fields.insert("client_id".to_string(), json!(client_id));
                }
            } else {
                payload = json!({
                    "run_id": self.run_id,
                    "conversation_id": self.conversation_id,
                    "client_id": self.client_id,
                    "data": payload,
                });
            }
            let _ = self.bridge.send_event(event, payload);
        }
    }

    pub(crate) fn confirm_tool(
        &self,
        tool_call_id: &str,
        tool_name: &str,
        summary: &str,
        arguments: Value,
    ) -> Result<ConfirmationDecision, String> {
        let decision = self.confirmations.request(
            &self.bridge,
            self.cancelled.as_ref(),
            ConfirmationRequest {
                run_id: &self.run_id,
                conversation_id: &self.conversation_id,
                client_id: self.client_id.as_deref(),
                tool_call_id,
                tool_name,
                summary,
                arguments,
            },
        )?;
        self.emit(
            "agent.confirmation.resolved",
            json!({
                "tool_call_id": tool_call_id,
                "tool_name": tool_name,
                "decision": decision.as_str(),
            }),
        );
        Ok(decision)
    }
}

pub(crate) fn start_agent_run(
    request: Request,
    settings: &Settings,
    bridge: &HostBridge,
    runs: &RunRegistry,
    conversations: &ConversationRegistry,
    confirmations: &ConfirmationRegistry,
) {
    let run_id = format!(
        "run-{}-{}",
        process::id(),
        NEXT_RUN_ID.fetch_add(1, Ordering::Relaxed)
    );
    let effective_settings =
        settings_from_params(&request.params).unwrap_or_else(|| settings.clone());
    let client_id = match resolve_client_id(&request.params) {
        Ok(client_id) => client_id,
        Err(error) => {
            let _ = bridge.send_response(err(request.id, "invalid_client_id", &error));
            return;
        }
    };
    let conversation_id = match resolve_conversation_id(&request.params) {
        Ok(conversation_id) => conversation_id,
        Err(error) => {
            let _ = bridge.send_response(err(request.id, "invalid_conversation_id", &error));
            return;
        }
    };
    let history = match conversation_messages(conversations, &conversation_id) {
        Ok(history) => history,
        Err(error) => {
            let _ = bridge.send_response(err(request.id, "conversation_failed", &error));
            return;
        }
    };
    let mut params = request.params;
    let Some(fields) = params.as_object_mut() else {
        let _ = bridge.send_response(err(
            request.id,
            "invalid_params",
            "agent.start params must be a JSON object",
        ));
        return;
    };
    fields.insert("history".to_string(), Value::Array(history));
    let user_message = fields
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string);
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Ok(mut active_runs) = runs.active.lock() {
        active_runs.insert(run_id.clone(), cancelled.clone());
    } else {
        let _ = bridge.send_response(err(
            request.id,
            "run_registry_failed",
            "failed to access agent run registry",
        ));
        return;
    }

    if let Err(error) = bridge.send_response(ok(
        request.id,
        json!({
            "run_id": run_id,
            "conversation_id": conversation_id,
            "state": "queued",
        }),
    )) {
        eprintln!("[native] failed to queue agent.start response: {error}");
        if let Ok(mut active_runs) = runs.active.lock() {
            active_runs.remove(&run_id);
        }
        return;
    }

    let context = RunContext {
        run_id: run_id.clone(),
        conversation_id: conversation_id.clone(),
        client_id,
        cancelled,
        bridge: bridge.clone(),
        confirmations: confirmations.clone(),
    };
    let active_runs = runs.clone();
    let conversation_registry = conversations.clone();
    thread::spawn(move || {
        if !context.is_cancelled() {
            context.emit("agent.status", json!({ "state": "running" }));
        }
        let result = run_agent(
            &params,
            &effective_settings,
            Some(&context),
            &context.bridge,
        );
        if !context.is_cancelled() {
            match result {
                Ok(result) => {
                    let saved = user_message
                        .as_deref()
                        .zip(result.get("message").and_then(Value::as_str))
                        .map(|(user, assistant)| {
                            append_conversation_turn_if_active(
                                &conversation_registry,
                                &conversation_id,
                                user,
                                assistant,
                                Some(context.cancelled.as_ref()),
                            )
                        })
                        .transpose();
                    match saved {
                        Ok(Some(false)) => {}
                        Ok(_) => context.emit("agent.done", json!({ "result": result })),
                        Err(error) => context.emit(
                            "agent.error",
                            json!({
                                "error": {
                                    "code": "conversation_save_failed",
                                    "message": error,
                                }
                            }),
                        ),
                    }
                }
                Err(error) => context.emit(
                    "agent.error",
                    json!({
                        "error": {
                            "code": "agent_run_failed",
                            "message": error,
                        }
                    }),
                ),
            }
        }
        if let Ok(mut runs) = active_runs.active.lock() {
            runs.remove(&run_id);
        }
    });
}

pub(crate) fn get_conversation(
    request: Request,
    bridge: &HostBridge,
    conversations: &ConversationRegistry,
) {
    let Some(conversation_id) = request
        .params
        .get("conversation_id")
        .and_then(Value::as_str)
    else {
        let _ = bridge.send_response(err(
            request.id,
            "invalid_params",
            "conversation_id is required",
        ));
        return;
    };
    match conversation_messages(conversations, conversation_id) {
        Ok(messages) => {
            let _ = bridge.send_response(ok(
                request.id,
                json!({
                    "conversation_id": conversation_id,
                    "message_count": messages.len(),
                }),
            ));
        }
        Err(error) => {
            let _ = bridge.send_response(err(request.id, "conversation_failed", &error));
        }
    }
}

pub(crate) fn reset_conversation(
    request: Request,
    bridge: &HostBridge,
    conversations: &ConversationRegistry,
) {
    let Some(conversation_id) = request
        .params
        .get("conversation_id")
        .and_then(Value::as_str)
    else {
        let _ = bridge.send_response(err(
            request.id,
            "invalid_params",
            "conversation_id is required",
        ));
        return;
    };
    let removed = conversations
        .conversations
        .lock()
        .map(|mut registry| registry.remove(conversation_id).is_some())
        .unwrap_or(false);
    let _ = bridge.send_response(ok(
        request.id,
        json!({ "conversation_id": conversation_id, "cleared": removed }),
    ));
}

pub(crate) fn cancel_agent_run(request: Request, bridge: &HostBridge, runs: &RunRegistry) {
    let Some(run_id) = request.params.get("run_id").and_then(Value::as_str) else {
        let _ = bridge.send_response(err(request.id, "invalid_params", "run_id is required"));
        return;
    };
    let cancelled = runs
        .active
        .lock()
        .ok()
        .and_then(|active_runs| active_runs.get(run_id).cloned());
    let Some(cancelled) = cancelled else {
        let _ = bridge.send_response(err(request.id, "run_not_found", "agent run was not found"));
        return;
    };
    cancelled.store(true, Ordering::SeqCst);
    let _ = bridge.send_response(ok(
        request.id,
        json!({ "run_id": run_id, "state": "cancelled" }),
    ));
    let mut payload = json!({ "run_id": run_id });
    if let Ok(Some(client_id)) = resolve_client_id(&request.params) {
        payload["client_id"] = json!(client_id);
    }
    let _ = bridge.send_event("agent.cancelled", payload);
}

pub(crate) fn reset_agent_runs(request: Request, bridge: &HostBridge, runs: &RunRegistry) {
    let run_ids = runs
        .active
        .lock()
        .map(|active_runs| {
            active_runs
                .iter()
                .map(|(run_id, cancelled)| {
                    cancelled.store(true, Ordering::SeqCst);
                    run_id.clone()
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let _ = bridge.send_response(ok(
        request.id,
        json!({ "ok": true, "cancelled_runs": run_ids.len() }),
    ));
    for run_id in run_ids {
        let _ = bridge.send_event("agent.cancelled", json!({ "run_id": run_id }));
    }
}

fn resolve_conversation_id(params: &Value) -> Result<String, String> {
    match params.get("conversation_id") {
        Some(Value::String(value)) => {
            let value = value.trim();
            if value.is_empty() || value.len() > 128 {
                return Err("conversation_id must contain 1 to 128 characters".to_string());
            }
            if !value
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
            {
                return Err("conversation_id contains unsupported characters".to_string());
            }
            return Ok(value.to_string());
        }
        Some(_) => return Err("conversation_id must be a string".to_string()),
        None => {}
    }
    Ok(format!(
        "conversation-{}-{}",
        process::id(),
        NEXT_CONVERSATION_ID.fetch_add(1, Ordering::Relaxed)
    ))
}

fn resolve_client_id(params: &Value) -> Result<Option<String>, String> {
    match params.get("client_id") {
        Some(Value::String(value)) => {
            let value = value.trim();
            if value.is_empty() || value.len() > 128 {
                return Err("client_id must contain 1 to 128 characters".to_string());
            }
            Ok(Some(value.to_string()))
        }
        Some(_) => Err("client_id must be a string".to_string()),
        None => Ok(None),
    }
}

fn conversation_messages(
    conversations: &ConversationRegistry,
    conversation_id: &str,
) -> Result<Vec<Value>, String> {
    conversations
        .conversations
        .lock()
        .map_err(|_| "failed to access conversation registry".to_string())
        .map(|registry| {
            registry
                .get(conversation_id)
                .map(|conversation| conversation.messages.clone())
                .unwrap_or_default()
        })
}

fn append_conversation_turn_if_active(
    conversations: &ConversationRegistry,
    conversation_id: &str,
    user: &str,
    assistant: &str,
    cancelled: Option<&AtomicBool>,
) -> Result<bool, String> {
    let mut registry = conversations
        .conversations
        .lock()
        .map_err(|_| "failed to access conversation registry".to_string())?;
    if cancelled.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
        return Ok(false);
    }
    if !registry.contains_key(conversation_id) && registry.len() >= MAX_CONVERSATIONS {
        let oldest = registry
            .iter()
            .min_by_key(|(_, conversation)| conversation.updated_at)
            .map(|(id, _)| id.clone());
        if let Some(oldest) = oldest {
            registry.remove(&oldest);
        }
    }
    let conversation = registry.entry(conversation_id.to_string()).or_default();
    conversation
        .messages
        .push(json!({ "role": "user", "content": user }));
    conversation
        .messages
        .push(json!({ "role": "assistant", "content": assistant }));
    conversation.updated_at = NEXT_CONVERSATION_UPDATE.fetch_add(1, Ordering::Relaxed);
    while conversation.messages.len() > MAX_HISTORY_MESSAGES {
        conversation.messages.drain(..2);
    }
    while serialized_size(&conversation.messages) > MAX_HISTORY_BYTES
        && conversation.messages.len() >= 2
    {
        conversation.messages.drain(..2);
    }
    Ok(true)
}

fn serialized_size(value: &impl Serialize) -> usize {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn test_bridge() -> (HostBridge, mpsc::Receiver<Value>) {
        let (outbound, output) = mpsc::channel();
        (HostBridge::new(outbound), output)
    }

    #[test]
    fn cancelling_a_run_acknowledges_and_emits_an_event() {
        let (bridge, output) = test_bridge();
        let runs = RunRegistry::default();
        let cancelled = Arc::new(AtomicBool::new(false));
        runs.active
            .lock()
            .unwrap()
            .insert("run-test".to_string(), cancelled.clone());

        cancel_agent_run(
            Request {
                id: "cancel-request".to_string(),
                method: "agent.cancel".to_string(),
                params: json!({ "run_id": "run-test", "client_id": "client-test" }),
            },
            &bridge,
            &runs,
        );

        assert!(cancelled.load(Ordering::SeqCst));
        let response = output.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(response["id"], "cancel-request");
        assert_eq!(response["result"]["state"], "cancelled");
        let event = output.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(event["event"], "agent.cancelled");
        assert_eq!(event["payload"]["run_id"], "run-test");
        assert_eq!(event["payload"]["client_id"], "client-test");
    }

    #[test]
    fn agent_start_returns_before_the_run_error_event() {
        let (bridge, output) = test_bridge();
        let runs = RunRegistry::default();
        let conversations = ConversationRegistry::default();
        let confirmations = ConfirmationRegistry::default();
        let settings = Settings {
            workspace_dir: String::new(),
            browser_tools_mode: "off".to_string(),
            ..Settings::default()
        };
        start_agent_run(
            Request {
                id: "start-request".to_string(),
                method: "agent.start".to_string(),
                params: json!({
                    "message": "hello",
                    "mode": "chat",
                    "client_id": "client-test",
                }),
            },
            &settings,
            &bridge,
            &runs,
            &conversations,
            &confirmations,
        );

        let response = output.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(response["id"], "start-request");
        let run_id = response["result"]["run_id"].as_str().unwrap();
        assert!(response["result"]["conversation_id"].as_str().is_some());
        let status = output.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(status["event"], "agent.status");
        assert_eq!(status["payload"]["run_id"], run_id);
        assert_eq!(status["payload"]["client_id"], "client-test");
        assert_eq!(
            status["payload"]["conversation_id"],
            response["result"]["conversation_id"]
        );
        let error = output.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(error["event"], "agent.error");
        assert_eq!(error["payload"]["run_id"], run_id);
    }

    #[test]
    fn conversation_turns_are_bounded_and_resettable() {
        let conversations = ConversationRegistry::default();
        for index in 0..20 {
            assert!(
                append_conversation_turn_if_active(
                    &conversations,
                    "conversation-test",
                    &format!("user {index}"),
                    &format!("assistant {index}"),
                    None,
                )
                .unwrap()
            );
        }

        let messages = conversation_messages(&conversations, "conversation-test").unwrap();
        assert_eq!(messages.len(), MAX_HISTORY_MESSAGES);
        assert_eq!(messages[0]["content"], "user 8");

        let (bridge, output) = test_bridge();
        reset_conversation(
            Request {
                id: "reset-request".to_string(),
                method: "conversation.reset".to_string(),
                params: json!({ "conversation_id": "conversation-test" }),
            },
            &bridge,
            &conversations,
        );
        let response = output.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(response["result"]["cleared"], true);
        assert!(
            conversation_messages(&conversations, "conversation-test")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn conversation_ids_are_validated() {
        assert!(resolve_conversation_id(&json!({ "conversation_id": 42 })).is_err());
        assert!(resolve_conversation_id(&json!({ "conversation_id": "bad/id" })).is_err());
        assert_eq!(
            resolve_conversation_id(&json!({ "conversation_id": "conversation.test-1" })).unwrap(),
            "conversation.test-1"
        );
    }
}
