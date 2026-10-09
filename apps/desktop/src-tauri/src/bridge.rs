//! The local MCP bridge: `mepmail-correio --mcp --mailbox <id>` speaks MCP
//! over stdio to an agent on this machine (Claude Desktop, Codex, Cursor,
//! Hermes…) and forwards every JSON-RPC message to the hosted Correio MCP
//! over HTTPS with the mailbox's agent key from the Windows credential vault.
//! The key never sits in an agent's config file, and stdio-only agents need
//! neither Node nor mcp-remote.

use std::{io::Write, time::Duration};

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};

pub const DEFAULT_ENDPOINT: &str = "https://api.mepmail.dev/mcp/correio";
pub const KEYRING_SERVICE: &str = "mepmail-correio";

/// The vault entry holding a mailbox's `mmb_` agent key.
pub fn key_entry(mailbox: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("agent-key:{mailbox}"))
}

/// The agent key for `mailbox`: the environment first (tests, CI), then the vault.
pub fn agent_key(mailbox: &str) -> Result<String, String> {
    if let Ok(key) = std::env::var("MEPMAIL_AGENT_KEY") {
        if !key.trim().is_empty() {
            return Ok(key.trim().to_string());
        }
    }
    key_entry(mailbox)
        .and_then(|entry| entry.get_password())
        .map_err(|error| format!("no agent key stored for mailbox {mailbox}: {error}"))
}

/// Splits a Server-Sent Events byte stream into `data` payloads.
#[derive(Default)]
pub struct SseParser {
    buffer: String,
    data: String,
}

impl SseParser {
    /// Feeds a chunk and returns every event completed by it.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.push_str(&String::from_utf8_lossy(chunk));
        let mut events = Vec::new();
        while let Some(end) = self.buffer.find('\n') {
            let line = self.buffer[..end].trim_end_matches('\r').to_string();
            self.buffer.drain(..=end);
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(std::mem::take(&mut self.data));
                }
            } else if let Some(rest) = line.strip_prefix("data:") {
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
            }
            // event:, id:, retry: and comments carry nothing the bridge forwards.
        }
        events
    }

    /// The event left open when the stream ends, if any. A last line without
    /// its newline still counts.
    pub fn finish(&mut self) -> Option<String> {
        if !self.buffer.is_empty() {
            let rest = std::mem::take(&mut self.buffer);
            let events = self.push(format!("{}\n", rest.trim_end_matches('\r')).as_bytes());
            if let Some(event) = events.into_iter().next() {
                return Some(event);
            }
        }
        if self.data.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.data))
        }
    }
}

fn write_line(stdout: &std::io::Stdout, text: &str) {
    let mut lock = stdout.lock();
    // The stdio transport is one JSON message per line.
    let _ = writeln!(lock, "{}", text.replace(['\n', '\r'], " "));
    let _ = lock.flush();
}

fn emit_error(stdout: &std::io::Stdout, id: Option<Value>, code: i64, message: &str) {
    let Some(id) = id else {
        eprintln!("mepmail-correio bridge: {message}");
        return;
    };
    let payload = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    });
    write_line(stdout, &payload.to_string());
}

/// Runs the bridge until stdin closes. Requests are handled one at a time,
/// in order, which is what the stdio transport's answers must follow anyway.
pub async fn run_stdio(mailbox: String, endpoint: String) -> Result<(), String> {
    let key = agent_key(&mailbox)?;
    let authorization = HeaderValue::from_str(&format!("Bearer {key}"))
        .map_err(|_| "the agent key contains characters a header cannot carry".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|error| error.to_string())?;
    let mut session: Option<HeaderValue> = None;
    let stdout = std::io::stdout();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        let message: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("mepmail-correio bridge: not JSON-RPC: {error}");
                continue;
            }
        };
        let id = message.get("id").cloned();
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, authorization.clone());
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/json, text/event-stream"),
        );
        if let Some(session) = &session {
            headers.insert("mcp-session-id", session.clone());
        }
        let response = match client
            .post(&endpoint)
            .headers(headers)
            .body(line)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                emit_error(&stdout, id, -32001, &format!("network: {error}"));
                continue;
            }
        };
        if let Some(value) = response.headers().get("mcp-session-id") {
            session = Some(value.clone());
        }
        let status = response.status();
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if status.as_u16() == 202 || status.as_u16() == 204 {
            continue;
        }
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let excerpt: String = body.chars().take(300).collect();
            emit_error(&stdout, id, -32000, &format!("{status}: {excerpt}"));
            continue;
        }
        if content_type.starts_with("text/event-stream") {
            let mut parser = SseParser::default();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(chunk) => {
                        for event in parser.push(&chunk) {
                            write_line(&stdout, &event);
                        }
                    }
                    Err(error) => {
                        eprintln!("mepmail-correio bridge: stream: {error}");
                        break;
                    }
                }
            }
            if let Some(event) = parser.finish() {
                write_line(&stdout, &event);
            }
        } else {
            let body = response.text().await.unwrap_or_default();
            let trimmed = body.trim();
            if !trimmed.is_empty() {
                write_line(&stdout, trimmed);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_events_across_chunks() {
        let mut parser = SseParser::default();
        assert!(parser.push(b"event: message\ndata: {\"a\":").is_empty());
        let events = parser.push(b"1}\n\ndata: second\n\n");
        assert_eq!(events, vec!["{\"a\":1}".to_string(), "second".to_string()]);
        assert!(parser.push(b": keep-alive\r\n\r\n").is_empty());
        assert!(parser.push(b"data: tail").is_empty());
        assert_eq!(parser.finish(), Some("tail".to_string()));
        assert_eq!(parser.finish(), None);
    }

    #[test]
    fn joins_multi_line_data() {
        let mut parser = SseParser::default();
        let events = parser.push(b"data: one\ndata:two\n\n");
        assert_eq!(events, vec!["one\ntwo".to_string()]);
    }
}
