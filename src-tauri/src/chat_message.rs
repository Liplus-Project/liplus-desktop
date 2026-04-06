use serde::{Deserialize, Serialize};

/// Content type classification for unified chat messages.
/// Maps CLI-specific message subtypes to a common taxonomy.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ContentType {
    Text,
    Thinking,
    ToolUse,
    ToolResult,
    Status,
}

/// Role of the message sender in the conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    System,
    Assistant,
    User,
}

/// Unified chat message type emitted to the frontend via Tauri events.
/// All CLI-specific message formats are normalized into this structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content_type: ContentType,
    pub body: String,
    /// Optional metadata from the original CLI message (preserved as raw JSON).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}
