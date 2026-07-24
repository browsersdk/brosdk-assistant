use crate::protocol::{HostBridge, Request, err, ok};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

const MAX_RUN_DETAILS: usize = 50;
const MAX_RUN_DETAIL_BYTES: usize = 768 * 1024;
const MAX_RUN_DETAILS_TOTAL_BYTES: usize = 8 * 1024 * 1024;
static NEXT_DETAILS_UPDATE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Default)]
pub(crate) struct RunDetailsRegistry {
    entries: Arc<Mutex<HashMap<String, StoredRunDetails>>>,
}

#[derive(Debug, Clone)]
struct StoredRunDetails {
    client_id: Option<String>,
    payload: Value,
    bytes: usize,
    updated_at: u64,
}

impl RunDetailsRegistry {
    pub(crate) fn store_completed(
        &self,
        run_id: &str,
        conversation_id: &str,
        client_id: Option<&str>,
        result: &mut Value,
    ) -> Result<bool, String> {
        let Some(fields) = result.as_object_mut() else {
            return Err("agent result must be a JSON object".to_string());
        };
        let debug = fields.remove("debug");
        fields.remove("tool_results");
        fields.remove("tool_name_map");
        let Some(debug) = debug else {
            fields.insert("details_available".to_string(), json!(false));
            return Ok(false);
        };
        let debug = bound_debug_value(debug)?;
        let payload = json!({
            "run_id": run_id,
            "conversation_id": conversation_id,
            "state": "completed",
            "debug": debug,
        });
        let bytes = serialized_size(&payload);
        if bytes > MAX_RUN_DETAIL_BYTES {
            fields.insert("details_available".to_string(), json!(false));
            return Ok(false);
        }

        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "failed to access run details".to_string())?;
        while !entries.is_empty()
            && (entries.len() >= MAX_RUN_DETAILS
                || entries.values().map(|entry| entry.bytes).sum::<usize>() + bytes
                    > MAX_RUN_DETAILS_TOTAL_BYTES)
        {
            let oldest = entries
                .iter()
                .min_by_key(|(_, entry)| entry.updated_at)
                .map(|(id, _)| id.clone());
            if let Some(oldest) = oldest {
                entries.remove(&oldest);
            }
        }
        entries.insert(
            run_id.to_string(),
            StoredRunDetails {
                client_id: client_id.map(str::to_string),
                payload,
                bytes,
                updated_at: NEXT_DETAILS_UPDATE.fetch_add(1, Ordering::Relaxed),
            },
        );
        fields.insert("details_available".to_string(), json!(true));
        Ok(true)
    }
}

pub(crate) fn get_run_details(request: Request, bridge: &HostBridge, details: &RunDetailsRegistry) {
    let Some(run_id) = request.params.get("run_id").and_then(Value::as_str) else {
        let _ = bridge.send_response(err(request.id, "invalid_params", "run_id is required"));
        return;
    };
    let client_id = match request.params.get("client_id") {
        Some(Value::String(value)) if !value.trim().is_empty() => Some(value.as_str()),
        Some(Value::String(_)) => {
            let _ = bridge.send_response(err(
                request.id,
                "invalid_params",
                "client_id must not be empty",
            ));
            return;
        }
        Some(_) => {
            let _ = bridge.send_response(err(
                request.id,
                "invalid_params",
                "client_id must be a string",
            ));
            return;
        }
        None => None,
    };
    let stored = details.entries.lock().ok().and_then(|entries| {
        entries
            .get(run_id)
            .filter(|entry| {
                entry
                    .client_id
                    .as_deref()
                    .is_none_or(|expected| Some(expected) == client_id)
            })
            .cloned()
    });
    match stored {
        Some(stored) => {
            let _ = bridge.send_response(ok(request.id, stored.payload));
        }
        None => {
            let _ = bridge.send_response(err(
                request.id,
                "run_details_not_found",
                "run details were not found, expired, or belong to another client",
            ));
        }
    }
}

fn bound_debug_value(debug: Value) -> Result<Value, String> {
    if serialized_size(&debug) <= MAX_RUN_DETAIL_BYTES {
        return Ok(debug);
    }
    let Some(mut fields) = debug.as_object().cloned() else {
        return Err("agent debug details must be a JSON object".to_string());
    };
    let message_count = array_len(&fields, "messages");
    let tool_result_count = array_len(&fields, "tool_results");
    let tool_count = array_len(&fields, "tools");
    fields.insert("details_truncated".to_string(), json!(true));
    fields.insert("messages_omitted".to_string(), json!(message_count));
    fields.insert("tool_results_omitted".to_string(), json!(tool_result_count));
    fields.insert("tools_omitted".to_string(), json!(tool_count));
    fields.insert("messages".to_string(), Value::Array(Vec::new()));
    fields.insert("tool_results".to_string(), Value::Array(Vec::new()));
    fields.insert("tools".to_string(), Value::Array(Vec::new()));
    fields.remove("tool_name_map");
    let bounded = Value::Object(fields);
    if serialized_size(&bounded) > MAX_RUN_DETAIL_BYTES {
        return Err("run details remain too large after truncation".to_string());
    }
    Ok(bounded)
}

fn array_len(fields: &Map<String, Value>, key: &str) -> usize {
    fields
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or_default()
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

    #[test]
    fn completed_details_are_detached_and_client_bound() {
        let registry = RunDetailsRegistry::default();
        let mut result = json!({
            "accepted": true,
            "message": "done",
            "tool_results": [{ "tool_name": "browser_active_tab" }],
            "tool_name_map": { "safe": "browser_active_tab" },
            "debug": {
                "system_prompt": "prompt",
                "messages": [],
                "tool_results": [{ "tool_name": "browser_active_tab" }]
            }
        });
        assert!(
            registry
                .store_completed("run-1", "conversation-1", Some("client-1"), &mut result)
                .unwrap()
        );
        assert_eq!(result["details_available"], true);
        assert!(result.get("debug").is_none());
        assert!(result.get("tool_results").is_none());
        assert!(result.get("tool_name_map").is_none());

        let (outbound, output) = mpsc::channel();
        let bridge = HostBridge::new(outbound);
        get_run_details(
            Request {
                id: "wrong-client".to_string(),
                method: "agent.run_details".to_string(),
                params: json!({ "run_id": "run-1", "client_id": "client-2" }),
            },
            &bridge,
            &registry,
        );
        let response = output.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(response["error"]["code"], "run_details_not_found");

        get_run_details(
            Request {
                id: "right-client".to_string(),
                method: "agent.run_details".to_string(),
                params: json!({ "run_id": "run-1", "client_id": "client-1" }),
            },
            &bridge,
            &registry,
        );
        let response = output.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(response["result"]["debug"]["system_prompt"], "prompt");
        assert_eq!(
            response["result"]["debug"]["tool_results"][0]["tool_name"],
            "browser_active_tab"
        );
    }

    #[test]
    fn oversized_details_keep_prompt_and_report_omissions() {
        let debug = json!({
            "system_prompt": "keep me",
            "messages": [{ "content": "x".repeat(MAX_RUN_DETAIL_BYTES) }],
            "tool_results": [{ "output": "large" }],
            "tools": [{ "name": "tool" }]
        });
        let bounded = bound_debug_value(debug).unwrap();
        assert_eq!(bounded["system_prompt"], "keep me");
        assert_eq!(bounded["details_truncated"], true);
        assert_eq!(bounded["messages_omitted"], 1);
        assert_eq!(bounded["tool_results_omitted"], 1);
        assert_eq!(bounded["tools_omitted"], 1);
    }

    #[test]
    fn detail_cache_evicts_the_oldest_entry() {
        let registry = RunDetailsRegistry::default();
        for index in 0..=MAX_RUN_DETAILS {
            let mut result = json!({
                "message": format!("answer-{index}"),
                "debug": { "system_prompt": format!("prompt-{index}") }
            });
            registry
                .store_completed(
                    &format!("run-{index}"),
                    "conversation-1",
                    Some("client-1"),
                    &mut result,
                )
                .unwrap();
        }
        let entries = registry.entries.lock().unwrap();
        assert_eq!(entries.len(), MAX_RUN_DETAILS);
        assert!(!entries.contains_key("run-0"));
        assert!(entries.contains_key(&format!("run-{MAX_RUN_DETAILS}")));
    }
}
