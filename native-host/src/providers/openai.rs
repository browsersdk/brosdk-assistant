use reqwest::blocking::Client as BlockingClient;
use reqwest::header::CONTENT_TYPE;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const MAX_MODEL_STREAM_LINE_BYTES: usize = 1024 * 1024;
const MODEL_CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(50);
const MODEL_REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

enum Transport {
    Blocking(BlockingClient),
    Streaming(reqwest::Client),
}

pub(crate) struct OpenAiProvider {
    endpoint: String,
    model: String,
    api_key: String,
    temperature: f64,
    transport: Transport,
}

impl OpenAiProvider {
    pub(crate) fn new(
        base_url: &str,
        model: &str,
        api_key: &str,
        temperature: f64,
        streaming: bool,
    ) -> Result<Self, String> {
        let endpoint = chat_completions_url(base_url)?;
        let transport = if streaming {
            Transport::Streaming(
                reqwest::Client::builder()
                    .timeout(MODEL_REQUEST_TIMEOUT)
                    .build()
                    .map_err(|error| format!("failed to create model HTTP client: {error}"))?,
            )
        } else {
            Transport::Blocking(
                BlockingClient::builder()
                    .timeout(MODEL_REQUEST_TIMEOUT)
                    .build()
                    .map_err(|error| format!("failed to create model HTTP client: {error}"))?,
            )
        };
        Ok(Self {
            endpoint,
            model: model.to_string(),
            api_key: api_key.to_string(),
            temperature,
            transport,
        })
    }

    pub(crate) fn chat(&self, messages: &[Value], tools: &[Value]) -> Result<Value, String> {
        let Transport::Blocking(http) = &self.transport else {
            return Err("blocking model client is unavailable".to_string());
        };
        let response = http
            .post(&self.endpoint)
            .bearer_auth(self.api_key.trim())
            .json(&self.request_body(messages, tools, false))
            .send()
            .map_err(|error| format!("model request failed: {error}"))?;
        let status = response.status();
        let text = response
            .text()
            .map_err(|error| format!("failed to read model response: {error}"))?;
        if !status.is_success() {
            return Err(format!("model request returned HTTP {status}: {text}"));
        }
        serde_json::from_str(&text).map_err(|error| format!("invalid model JSON response: {error}"))
    }

    pub(crate) fn chat_stream<F>(
        &self,
        messages: &[Value],
        tools: &[Value],
        cancelled: &AtomicBool,
        on_delta: F,
    ) -> Result<Value, String>
    where
        F: FnMut(String),
    {
        let Transport::Streaming(http) = &self.transport else {
            return Err("streaming model client is unavailable".to_string());
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| format!("failed to create model HTTP runtime: {error}"))?;
        runtime.block_on(self.chat_stream_async(http, messages, tools, cancelled, on_delta))
    }

    async fn chat_stream_async<F>(
        &self,
        http: &reqwest::Client,
        messages: &[Value],
        tools: &[Value],
        cancelled: &AtomicBool,
        mut on_delta: F,
    ) -> Result<Value, String>
    where
        F: FnMut(String),
    {
        let mut response = await_model_io(
            http.post(&self.endpoint)
                .bearer_auth(self.api_key.trim())
                .json(&self.request_body(messages, tools, true))
                .send(),
            cancelled,
            "model request failed",
        )
        .await?;
        let status = response.status();
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        if !status.is_success() {
            let text = await_model_io(
                response.text(),
                cancelled,
                "failed to read model error response",
            )
            .await?;
            return Err(format!("model request returned HTTP {status}: {text}"));
        }
        if !content_type.contains("text/event-stream") {
            let text =
                await_model_io(response.text(), cancelled, "failed to read model response").await?;
            return serde_json::from_str(&text)
                .map_err(|error| format!("invalid model JSON response: {error}"));
        }

        let mut decoder = SseLineDecoder::default();
        let mut accumulator = OpenAiStreamAccumulator::default();
        let mut done = false;
        while !done {
            let Some(chunk) =
                await_model_io(response.chunk(), cancelled, "failed to read model stream").await?
            else {
                break;
            };
            for line in decoder.push(&chunk)? {
                if apply_sse_line(&line, &mut accumulator, &mut on_delta)? {
                    done = true;
                    break;
                }
            }
        }
        if !done {
            for line in decoder.finish()? {
                if apply_sse_line(&line, &mut accumulator, &mut on_delta)? {
                    break;
                }
            }
        }
        Ok(json!({
            "choices": [{ "message": accumulator.into_message() }]
        }))
    }

    fn request_body(&self, messages: &[Value], tools: &[Value], streaming: bool) -> Value {
        let mut body = json!({
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
        });
        if streaming {
            body["stream"] = json!(true);
        }
        if !tools.is_empty() {
            body["tools"] = Value::Array(tools.to_vec());
            body["tool_choice"] = json!("auto");
        }
        body
    }
}

fn chat_completions_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("model_base_url is required".to_string());
    }
    if trimmed.ends_with("/chat/completions") {
        return Ok(trimmed.to_string());
    }
    Ok(format!("{trimmed}/chat/completions"))
}

async fn await_model_io<T, F>(
    future: F,
    cancelled: &AtomicBool,
    operation: &str,
) -> Result<T, String>
where
    F: Future<Output = reqwest::Result<T>>,
{
    tokio::pin!(future);
    let mut cancellation = tokio::time::interval(MODEL_CANCEL_POLL_INTERVAL);
    cancellation.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            biased;
            _ = cancellation.tick() => {
                if cancelled.load(Ordering::SeqCst) {
                    return Err("run cancelled".to_string());
                }
            },
            result = &mut future => {
                return result.map_err(|error| format!("{operation}: {error}"));
            }
        }
    }
}

fn apply_sse_line<F>(
    line: &str,
    accumulator: &mut OpenAiStreamAccumulator,
    on_delta: &mut F,
) -> Result<bool, String>
where
    F: FnMut(String),
{
    let trimmed = line.trim();
    let Some(data) = trimmed.strip_prefix("data:") else {
        return Ok(false);
    };
    let data = data.trim();
    if data.is_empty() {
        return Ok(false);
    }
    if data == "[DONE]" {
        return Ok(true);
    }
    let chunk = serde_json::from_str::<Value>(data)
        .map_err(|error| format!("invalid model stream JSON: {error}"))?;
    for delta in accumulator.apply_chunk(&chunk)? {
        on_delta(delta);
    }
    Ok(false)
}

#[derive(Debug, Default)]
struct StreamedToolCall {
    id: Option<String>,
    name: String,
    arguments: String,
}

#[derive(Debug, Default)]
struct OpenAiStreamAccumulator {
    content: String,
    tool_calls: BTreeMap<usize, StreamedToolCall>,
}

impl OpenAiStreamAccumulator {
    fn apply_chunk(&mut self, chunk: &Value) -> Result<Vec<String>, String> {
        if let Some(error) = chunk.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| error.to_string());
            return Err(format!("model stream failed: {message}"));
        }
        let Some(delta) = chunk
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("delta"))
        else {
            return Ok(Vec::new());
        };

        let mut content_deltas = Vec::new();
        if let Some(content) = delta.get("content").and_then(Value::as_str)
            && !content.is_empty()
        {
            self.content.push_str(content);
            content_deltas.push(content.to_string());
        }
        if let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for (position, tool_call) in tool_calls.iter().enumerate() {
                let index = tool_call
                    .get("index")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize)
                    .unwrap_or(position);
                let entry = self.tool_calls.entry(index).or_default();
                if let Some(id) = tool_call.get("id").and_then(Value::as_str) {
                    entry.id = Some(id.to_string());
                }
                if let Some(function) = tool_call.get("function") {
                    if let Some(name) = function.get("name").and_then(Value::as_str) {
                        entry.name.push_str(name);
                    }
                    if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                        entry.arguments.push_str(arguments);
                    }
                }
            }
        }
        Ok(content_deltas)
    }

    fn into_message(self) -> Value {
        let tool_calls = self
            .tool_calls
            .into_iter()
            .map(|(index, tool_call)| {
                json!({
                    "id": tool_call.id.unwrap_or_else(|| format!("tool-call-{index}")),
                    "type": "function",
                    "function": {
                        "name": tool_call.name,
                        "arguments": tool_call.arguments,
                    }
                })
            })
            .collect::<Vec<_>>();
        let content = if self.content.is_empty() {
            Value::Null
        } else {
            Value::String(self.content)
        };
        let mut message = json!({ "role": "assistant", "content": content });
        if !tool_calls.is_empty() {
            message["tool_calls"] = Value::Array(tool_calls);
        }
        message
    }
}

#[derive(Debug, Default)]
struct SseLineDecoder {
    buffer: Vec<u8>,
}

impl SseLineDecoder {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, String> {
        self.buffer.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(newline) = self.buffer.iter().position(|byte| *byte == b'\n') {
            if newline > MAX_MODEL_STREAM_LINE_BYTES {
                return Err("model stream line exceeded the size limit".to_string());
            }
            let mut line = self.buffer.drain(..=newline).collect::<Vec<_>>();
            while matches!(line.last(), Some(b'\n' | b'\r')) {
                line.pop();
            }
            lines.push(
                String::from_utf8(line)
                    .map_err(|_| "model stream contained invalid UTF-8".to_string())?,
            );
        }
        if self.buffer.len() > MAX_MODEL_STREAM_LINE_BYTES {
            return Err("model stream line exceeded the size limit".to_string());
        }
        Ok(lines)
    }

    fn finish(&mut self) -> Result<Vec<String>, String> {
        if self.buffer.is_empty() {
            return Ok(Vec::new());
        }
        let line = std::mem::take(&mut self.buffer);
        Ok(vec![String::from_utf8(line).map_err(|_| {
            "model stream contained invalid UTF-8".to_string()
        })?])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Instant;

    #[test]
    fn stream_accumulates_content_and_tool_call_fragments() {
        let mut accumulator = OpenAiStreamAccumulator::default();
        let first_deltas = accumulator
            .apply_chunk(&json!({
                "choices": [{
                    "delta": {
                        "content": "Hello ",
                        "tool_calls": [{
                            "index": 0,
                            "id": "call-1",
                            "function": {
                                "name": "workspace_",
                                "arguments": "{\"path\":\""
                            }
                        }]
                    }
                }]
            }))
            .unwrap();
        let second_deltas = accumulator
            .apply_chunk(&json!({
                "choices": [{
                    "delta": {
                        "content": "world",
                        "tool_calls": [{
                            "index": 0,
                            "function": {
                                "name": "read_file",
                                "arguments": "notes.txt\"}"
                            }
                        }]
                    }
                }]
            }))
            .unwrap();

        assert_eq!(first_deltas, vec!["Hello "]);
        assert_eq!(second_deltas, vec!["world"]);
        let message = accumulator.into_message();
        assert_eq!(message["content"], "Hello world");
        assert_eq!(message["tool_calls"][0]["id"], "call-1");
        assert_eq!(
            message["tool_calls"][0]["function"]["name"],
            "workspace_read_file"
        );
        assert_eq!(
            message["tool_calls"][0]["function"]["arguments"],
            "{\"path\":\"notes.txt\"}"
        );
    }

    #[test]
    fn sse_decoder_handles_arbitrary_chunk_boundaries() {
        let mut decoder = SseLineDecoder::default();
        let mut accumulator = OpenAiStreamAccumulator::default();
        let mut deltas = Vec::new();
        let mut done = false;

        assert!(
            decoder
                .push(b"data: {\"choices\":[{\"delta\":{\"content\":\"hel")
                .unwrap()
                .is_empty()
        );
        for line in decoder.push(b"lo\"}}]}\r\n\r\ndata: [DO").unwrap() {
            done |=
                apply_sse_line(&line, &mut accumulator, &mut |delta| deltas.push(delta)).unwrap();
        }
        for line in decoder.push(b"NE]\n").unwrap() {
            done |=
                apply_sse_line(&line, &mut accumulator, &mut |delta| deltas.push(delta)).unwrap();
        }

        assert!(done);
        assert!(decoder.finish().unwrap().is_empty());
        assert_eq!(deltas, vec!["hello"]);
        assert_eq!(accumulator.into_message()["content"], "hello");
    }

    #[test]
    fn stream_surfaces_provider_errors() {
        let mut accumulator = OpenAiStreamAccumulator::default();
        let error = accumulator
            .apply_chunk(&json!({ "error": { "message": "rate limited" } }))
            .expect_err("stream error should fail");
        assert!(error.contains("rate limited"));
    }

    #[test]
    fn stream_cancellation_interrupts_a_stalled_http_read() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (ready_sender, ready_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
            stream.flush().unwrap();
            ready_sender.send(()).unwrap();
            let _ = release_receiver.recv_timeout(Duration::from_secs(5));
        });

        let provider = OpenAiProvider::new(
            &format!("http://{address}"),
            "test-model",
            "test-key",
            0.0,
            true,
        )
        .unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = cancelled.clone();
        let (result_sender, result_receiver) = mpsc::channel();
        thread::spawn(move || {
            let result = provider.chat_stream(
                &[json!({ "role": "user", "content": "hello" })],
                &[],
                worker_cancelled.as_ref(),
                |_| {},
            );
            result_sender.send(result).unwrap();
        });

        ready_receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("model request did not reach the stalled response body");
        let cancelled_at = Instant::now();
        cancelled.store(true, Ordering::SeqCst);
        let result = result_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("cancelled model request did not stop promptly");
        assert_eq!(result.unwrap_err(), "run cancelled");
        assert!(cancelled_at.elapsed() < Duration::from_secs(1));

        release_sender.send(()).unwrap();
        server.join().unwrap();
    }
}
