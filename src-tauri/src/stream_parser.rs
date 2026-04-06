use crate::chat_message::{ChatMessage, ContentType, Role};
use serde_json::Value;

/// Identifies which CLI produced the NDJSON stream.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CliKind {
    ClaudeCode,
    Codex,
}

// ---------------------------------------------------------------------------
// Common layer: NDJSON line parser
// ---------------------------------------------------------------------------

/// Parse a single line of NDJSON into a serde_json::Value.
/// Returns None for blank lines or lines that fail to parse (e.g. ANSI noise).
pub fn parse_ndjson_line(line: &str) -> Option<Value> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

// ---------------------------------------------------------------------------
// CLI-specific conversion layer
// ---------------------------------------------------------------------------

/// Convert a raw JSON value into a unified ChatMessage using the appropriate
/// CLI-specific converter. Returns None when the message type is unknown or
/// should be silently dropped (e.g. internal bookkeeping events).
pub fn convert(kind: CliKind, value: &Value) -> Option<ChatMessage> {
    match kind {
        CliKind::ClaudeCode => convert_claude(value),
        CliKind::Codex => convert_codex(value),
    }
}

// ---------------------------------------------------------------------------
// Claude Code converter
// ---------------------------------------------------------------------------
//
// Known message types from `claude --print --output-format stream-json --verbose`:
//   { "type": "system",  "subtype": "init", ... }
//   { "type": "assistant", "message": { "content": [ { "type": "thinking"|"text"|"tool_use", ... } ] } }
//   { "type": "user",     "message": { "content": [ { "type": "tool_result", ... } ] } }
//   { "type": "result",   "subtype": "success", "result": "..." }

fn convert_claude(v: &Value) -> Option<ChatMessage> {
    let msg_type = v.get("type")?.as_str()?;

    match msg_type {
        // --- system (init, etc.) ---
        "system" => {
            let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
            let body = match subtype {
                "init" => format!(
                    "Session initialized: {}",
                    v.get("session_id")
                        .and_then(|s| s.as_str())
                        .unwrap_or("unknown")
                ),
                _ => format!("system:{subtype}"),
            };
            Some(ChatMessage {
                role: Role::System,
                content_type: ContentType::Status,
                body,
                metadata: Some(v.clone()),
            })
        }

        // --- assistant turn ---
        "assistant" => {
            let content = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())?;

            // Flatten all content blocks into one ChatMessage per block.
            // We return the first meaningful block; the caller can invoke
            // convert_claude_all() if it needs every block.
            for block in content {
                let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match block_type {
                    "thinking" => {
                        let text = block.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
                        if !text.is_empty() {
                            return Some(ChatMessage {
                                role: Role::Assistant,
                                content_type: ContentType::Thinking,
                                body: text.to_string(),
                                metadata: Some(block.clone()),
                            });
                        }
                    }
                    "text" => {
                        let text = block.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        if !text.is_empty() {
                            return Some(ChatMessage {
                                role: Role::Assistant,
                                content_type: ContentType::Text,
                                body: text.to_string(),
                                metadata: None,
                            });
                        }
                    }
                    "tool_use" => {
                        let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                        let input = block
                            .get("input")
                            .map(|i| i.to_string())
                            .unwrap_or_default();
                        return Some(ChatMessage {
                            role: Role::Assistant,
                            content_type: ContentType::ToolUse,
                            body: format!("{name}: {input}"),
                            metadata: Some(block.clone()),
                        });
                    }
                    _ => {}
                }
            }
            None
        }

        // --- user turn (tool_result) ---
        "user" => {
            let content = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())?;

            for block in content {
                let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if block_type == "tool_result" {
                    let output = block
                        .get("content")
                        .and_then(|c| {
                            if let Some(s) = c.as_str() {
                                Some(s.to_string())
                            } else if let Some(arr) = c.as_array() {
                                // content can be array of { type: "text", text: "..." }
                                let texts: Vec<&str> = arr
                                    .iter()
                                    .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                                    .collect();
                                if texts.is_empty() {
                                    None
                                } else {
                                    Some(texts.join("\n"))
                                }
                            } else {
                                None
                            }
                        })
                        .unwrap_or_default();
                    return Some(ChatMessage {
                        role: Role::User,
                        content_type: ContentType::ToolResult,
                        body: output,
                        metadata: Some(block.clone()),
                    });
                }
            }
            None
        }

        // --- result ---
        "result" => {
            let result_text = v
                .get("result")
                .and_then(|r| r.as_str())
                .unwrap_or("")
                .to_string();
            Some(ChatMessage {
                role: Role::Assistant,
                content_type: ContentType::Text,
                body: result_text,
                metadata: Some(v.clone()),
            })
        }

        // --- rate_limit_event ---
        "rate_limit_event" => Some(ChatMessage {
            role: Role::System,
            content_type: ContentType::Status,
            body: "Rate limit reached — waiting".to_string(),
            metadata: Some(v.clone()),
        }),

        _ => None,
    }
}

/// Convert a single Claude Code JSON value into *all* ChatMessages it contains
/// (one per content block). Useful for messages with multiple blocks.
pub fn convert_claude_all(v: &Value) -> Vec<ChatMessage> {
    let msg_type = match v.get("type").and_then(|t| t.as_str()) {
        Some(t) => t,
        None => return vec![],
    };

    match msg_type {
        "assistant" | "user" => {
            let content = match v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            {
                Some(c) => c,
                None => return vec![],
            };

            let role = if msg_type == "assistant" {
                Role::Assistant
            } else {
                Role::User
            };

            content
                .iter()
                .filter_map(|block| {
                    let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    match block_type {
                        "thinking" => {
                            let text = block.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
                            if text.is_empty() {
                                return None;
                            }
                            Some(ChatMessage {
                                role: role.clone(),
                                content_type: ContentType::Thinking,
                                body: text.to_string(),
                                metadata: Some(block.clone()),
                            })
                        }
                        "text" => {
                            let text = block.get("text").and_then(|t| t.as_str()).unwrap_or("");
                            if text.is_empty() {
                                return None;
                            }
                            Some(ChatMessage {
                                role: role.clone(),
                                content_type: ContentType::Text,
                                body: text.to_string(),
                                metadata: None,
                            })
                        }
                        "tool_use" => {
                            let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                            let input = block
                                .get("input")
                                .map(|i| i.to_string())
                                .unwrap_or_default();
                            Some(ChatMessage {
                                role: role.clone(),
                                content_type: ContentType::ToolUse,
                                body: format!("{name}: {input}"),
                                metadata: Some(block.clone()),
                            })
                        }
                        "tool_result" => {
                            let output = block
                                .get("content")
                                .and_then(|c| c.as_str())
                                .unwrap_or("")
                                .to_string();
                            Some(ChatMessage {
                                role: role.clone(),
                                content_type: ContentType::ToolResult,
                                body: output,
                                metadata: Some(block.clone()),
                            })
                        }
                        _ => None,
                    }
                })
                .collect()
        }
        _ => {
            // For non-multi-block types, delegate to single converter
            convert_claude(v).into_iter().collect()
        }
    }
}

// ---------------------------------------------------------------------------
// Codex CLI converter
// ---------------------------------------------------------------------------
//
// Known message types from `codex exec --json`:
//   { "type": "thread.started", ... }
//   { "type": "turn.started",   ... }
//   { "type": "turn.completed", ... }
//   { "type": "item.started",   "item": { "type": "agent_message"|"command_execution"|"reasoning", ... } }
//   { "type": "item.completed", "item": { "type": "agent_message"|"command_execution"|"reasoning", ... } }

fn convert_codex(v: &Value) -> Option<ChatMessage> {
    let msg_type = v.get("type")?.as_str()?;

    match msg_type {
        "thread.started" => Some(ChatMessage {
            role: Role::System,
            content_type: ContentType::Status,
            body: "Thread started".to_string(),
            metadata: Some(v.clone()),
        }),

        "turn.started" => Some(ChatMessage {
            role: Role::System,
            content_type: ContentType::Status,
            body: "Turn started".to_string(),
            metadata: Some(v.clone()),
        }),

        "turn.completed" => Some(ChatMessage {
            role: Role::System,
            content_type: ContentType::Status,
            body: "Turn completed".to_string(),
            metadata: Some(v.clone()),
        }),

        "item.started" | "item.completed" => {
            let item = v.get("item")?;
            let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");

            match item_type {
                "agent_message" => {
                    // Extract text from content array or content string
                    let body = extract_codex_text(item);
                    if body.is_empty() {
                        return None;
                    }
                    Some(ChatMessage {
                        role: Role::Assistant,
                        content_type: ContentType::Text,
                        body,
                        metadata: Some(item.clone()),
                    })
                }
                "command_execution" => {
                    let command = item.get("command").and_then(|c| c.as_str()).unwrap_or("");
                    let output = item.get("output").and_then(|o| o.as_str()).unwrap_or("");
                    let body = if output.is_empty() {
                        format!("$ {command}")
                    } else {
                        format!("$ {command}\n{output}")
                    };
                    // command_execution maps to tool_use (started) or tool_result (completed)
                    let content_type = if msg_type == "item.started" {
                        ContentType::ToolUse
                    } else {
                        ContentType::ToolResult
                    };
                    Some(ChatMessage {
                        role: if msg_type == "item.started" {
                            Role::Assistant
                        } else {
                            Role::User
                        },
                        content_type,
                        body,
                        metadata: Some(item.clone()),
                    })
                }
                "reasoning" => {
                    let text = extract_codex_text(item);
                    if text.is_empty() {
                        return None;
                    }
                    Some(ChatMessage {
                        role: Role::Assistant,
                        content_type: ContentType::Thinking,
                        body: text,
                        metadata: Some(item.clone()),
                    })
                }
                _ => None,
            }
        }

        _ => None,
    }
}

/// Extract text from a Codex item's content field.
/// Content can be a string or an array of { type: "text", text: "..." } objects.
fn extract_codex_text(item: &Value) -> String {
    if let Some(content) = item.get("content") {
        if let Some(s) = content.as_str() {
            return s.to_string();
        }
        if let Some(arr) = content.as_array() {
            let texts: Vec<&str> = arr
                .iter()
                .filter_map(|block| block.get("text").and_then(|t| t.as_str()))
                .collect();
            return texts.join("\n");
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_valid_ndjson() {
        let line = r#"{"type":"system","subtype":"init","session_id":"abc123"}"#;
        let val = parse_ndjson_line(line);
        assert!(val.is_some());
        assert_eq!(val.unwrap()["type"], "system");
    }

    #[test]
    fn parse_blank_line() {
        assert!(parse_ndjson_line("").is_none());
        assert!(parse_ndjson_line("   ").is_none());
    }

    #[test]
    fn parse_invalid_json() {
        assert!(parse_ndjson_line("not json at all").is_none());
        assert!(parse_ndjson_line("\x1b[0msome ansi").is_none());
    }

    #[test]
    fn claude_system_init() {
        let v: Value =
            serde_json::from_str(r#"{"type":"system","subtype":"init","session_id":"sess-42"}"#)
                .unwrap();
        let msg = convert(CliKind::ClaudeCode, &v).unwrap();
        assert_eq!(msg.role, Role::System);
        assert_eq!(msg.content_type, ContentType::Status);
        assert!(msg.body.contains("sess-42"));
    }

    #[test]
    fn claude_assistant_text() {
        let v: Value = serde_json::from_str(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello world"}]}}"#,
        )
        .unwrap();
        let msg = convert(CliKind::ClaudeCode, &v).unwrap();
        assert_eq!(msg.role, Role::Assistant);
        assert_eq!(msg.content_type, ContentType::Text);
        assert_eq!(msg.body, "Hello world");
    }

    #[test]
    fn claude_result() {
        let v: Value =
            serde_json::from_str(r#"{"type":"result","subtype":"success","result":"Done!"}"#)
                .unwrap();
        let msg = convert(CliKind::ClaudeCode, &v).unwrap();
        assert_eq!(msg.role, Role::Assistant);
        assert_eq!(msg.body, "Done!");
    }

    #[test]
    fn codex_thread_started() {
        let v: Value = serde_json::from_str(r#"{"type":"thread.started"}"#).unwrap();
        let msg = convert(CliKind::Codex, &v).unwrap();
        assert_eq!(msg.role, Role::System);
        assert_eq!(msg.content_type, ContentType::Status);
    }

    #[test]
    fn codex_agent_message() {
        let v: Value = serde_json::from_str(
            r#"{"type":"item.completed","item":{"type":"agent_message","content":"Response text"}}"#,
        )
        .unwrap();
        let msg = convert(CliKind::Codex, &v).unwrap();
        assert_eq!(msg.role, Role::Assistant);
        assert_eq!(msg.content_type, ContentType::Text);
        assert_eq!(msg.body, "Response text");
    }

    #[test]
    fn codex_command_execution() {
        let v: Value = serde_json::from_str(
            r#"{"type":"item.started","item":{"type":"command_execution","command":"ls -la","output":""}}"#,
        )
        .unwrap();
        let msg = convert(CliKind::Codex, &v).unwrap();
        assert_eq!(msg.role, Role::Assistant);
        assert_eq!(msg.content_type, ContentType::ToolUse);
        assert!(msg.body.contains("ls -la"));
    }
}
