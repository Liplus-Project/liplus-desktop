import { renderMarkdown } from "./markdown";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Types — mirrors Rust ChatMessage / ContentType / Role
// ---------------------------------------------------------------------------

type ContentType = "text" | "thinking" | "tool_use" | "tool_result" | "status";
type Role = "system" | "assistant" | "user";

interface ChatMessage {
  role: Role;
  content_type: ContentType;
  body: string;
  metadata?: unknown;
}

// ---------------------------------------------------------------------------
// ChatPane — one chat UI instance (left or right pane)
// ---------------------------------------------------------------------------

export class ChatPane {
  private container: HTMLElement;
  private messagesEl: HTMLElement;
  private textareaEl: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private ptyId: string | null = null;
  private unlistenChat: UnlistenFn | null = null;
  private unlistenExit: UnlistenFn | null = null;
  /** Whether user has scrolled up (disables auto-scroll) */
  private userScrolled = false;
  /** Element for the currently streaming assistant message (appended incrementally) */
  private streamingBubble: HTMLElement | null = null;
  /** Accumulated body text for the current streaming message */
  private streamingBody = "";
  /** Content type of the current streaming message */
  private streamingType: ContentType | null = null;

  constructor(containerId: string) {
    this.container = document.getElementById(containerId)!;

    // Build DOM structure
    this.messagesEl = document.createElement("div");
    this.messagesEl.className = "chat-messages";

    const inputArea = document.createElement("div");
    inputArea.className = "chat-input-area";

    this.textareaEl = document.createElement("textarea");
    this.textareaEl.className = "chat-textarea";
    this.textareaEl.placeholder = "Type a message...";
    this.textareaEl.rows = 1;

    this.sendBtn = document.createElement("button");
    this.sendBtn.className = "chat-send-btn";
    this.sendBtn.textContent = "Send";
    this.sendBtn.disabled = true;

    inputArea.appendChild(this.textareaEl);
    inputArea.appendChild(this.sendBtn);

    this.container.appendChild(this.messagesEl);
    this.container.appendChild(inputArea);

    // --- Event listeners ---

    // Auto-scroll detection
    this.messagesEl.addEventListener("scroll", () => {
      const el = this.messagesEl;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      this.userScrolled = !atBottom;
    });

    // Enter to send, Shift+Enter for newline
    this.textareaEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    // Auto-resize textarea
    this.textareaEl.addEventListener("input", () => {
      this.textareaEl.style.height = "auto";
      this.textareaEl.style.height =
        Math.min(this.textareaEl.scrollHeight, 120) + "px";
    });

    this.sendBtn.addEventListener("click", () => this.sendMessage());
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Attach to a running PTY session — start listening for chat-message events. */
  async attach(ptyId: string): Promise<void> {
    this.ptyId = ptyId;
    this.sendBtn.disabled = false;

    this.unlistenChat = await listen<ChatMessage>(
      `chat-message-${ptyId}`,
      (event) => {
        this.onChatMessage(event.payload);
      },
    );

    this.unlistenExit = await listen<number | null>(
      `pty-exit-${ptyId}`,
      (event) => {
        const code = event.payload;
        this.appendStatusBanner(
          code !== null && code !== 0
            ? `Process exited with code ${code}`
            : "Process exited",
        );
        this.detach();
      },
    );
  }

  /** Detach from PTY — stop listening, disable input. */
  detach(): void {
    this.ptyId = null;
    this.sendBtn.disabled = true;
    this.finalizeStreaming();
    if (this.unlistenChat) {
      this.unlistenChat();
      this.unlistenChat = null;
    }
    if (this.unlistenExit) {
      this.unlistenExit();
      this.unlistenExit = null;
    }
  }

  /** Clear all messages. */
  clear(): void {
    this.messagesEl.innerHTML = "";
    this.streamingBubble = null;
    this.streamingBody = "";
    this.streamingType = null;
  }

  /** Show an informational banner (e.g. welcome text). */
  appendStatusBanner(text: string): void {
    const el = document.createElement("div");
    el.className = "chat-status-banner";
    el.textContent = text;
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  /** Get the current PTY id (null if not attached). */
  getPtyId(): string | null {
    return this.ptyId;
  }

  // -----------------------------------------------------------------------
  // Message handling
  // -----------------------------------------------------------------------

  private onChatMessage(msg: ChatMessage): void {
    // Streaming: consecutive assistant text/thinking messages accumulate
    // into the same bubble until a different type arrives.
    if (
      msg.role === "assistant" &&
      (msg.content_type === "text" || msg.content_type === "thinking")
    ) {
      if (this.streamingType === msg.content_type && this.streamingBubble) {
        // Continue accumulating
        this.streamingBody += msg.body;
        this.updateStreamingBubble();
        return;
      }
      // New streaming sequence — finalize previous if any
      this.finalizeStreaming();
      this.streamingType = msg.content_type;
      this.streamingBody = msg.body;
      this.streamingBubble = this.createBubble(msg);
      this.messagesEl.appendChild(this.streamingBubble);
      this.updateStreamingBubble();
      return;
    }

    // Non-streaming message — finalize any ongoing stream first
    this.finalizeStreaming();

    switch (msg.content_type) {
      case "tool_use":
        this.appendToolUse(msg);
        break;
      case "tool_result":
        this.appendToolResult(msg);
        break;
      case "status":
        this.appendStatusBanner(msg.body);
        break;
      default:
        this.appendBubble(msg);
    }
  }

  private finalizeStreaming(): void {
    if (this.streamingBubble) {
      // Final render with complete body
      this.updateStreamingBubble();
    }
    this.streamingBubble = null;
    this.streamingBody = "";
    this.streamingType = null;
  }

  private updateStreamingBubble(): void {
    if (!this.streamingBubble) return;

    const contentEl = this.streamingBubble.querySelector(".bubble-content");
    if (!contentEl) return;

    if (this.streamingType === "thinking") {
      // Thinking: update the content inside the <details> element
      const detailsContent =
        this.streamingBubble.querySelector(".thinking-content");
      if (detailsContent) {
        detailsContent.innerHTML = renderMarkdown(this.streamingBody);
      }
    } else {
      contentEl.innerHTML = renderMarkdown(this.streamingBody);
    }

    this.scrollToBottom();
  }

  // -----------------------------------------------------------------------
  // Bubble creation helpers
  // -----------------------------------------------------------------------

  private createBubble(msg: ChatMessage): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = `chat-bubble-row ${msg.role === "user" ? "bubble-right" : "bubble-left"}`;

    const bubble = document.createElement("div");
    bubble.className = `chat-bubble chat-bubble-${msg.role}`;

    if (msg.content_type === "thinking") {
      // Collapsible thinking section
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.className = "thinking-summary";
      summary.textContent = "Thinking...";
      const content = document.createElement("div");
      content.className = "thinking-content bubble-content";
      content.innerHTML = renderMarkdown(msg.body);
      details.appendChild(summary);
      details.appendChild(content);
      bubble.appendChild(details);
    } else {
      const content = document.createElement("div");
      content.className = "bubble-content";
      content.innerHTML = renderMarkdown(msg.body);
      bubble.appendChild(content);
    }

    wrapper.appendChild(bubble);
    return wrapper;
  }

  private appendBubble(msg: ChatMessage): void {
    const el = this.createBubble(msg);
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  private appendToolUse(msg: ChatMessage): void {
    const el = document.createElement("div");
    el.className = "chat-tool-status";

    // Extract tool name from body format "name: {input}"
    const colonIdx = msg.body.indexOf(":");
    const toolName = colonIdx > 0 ? msg.body.slice(0, colonIdx) : msg.body;

    el.innerHTML = `<span class="tool-icon">&#9881;</span> <span class="tool-name">${this.escapeHtml(toolName)}</span>`;
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  private appendToolResult(msg: ChatMessage): void {
    const el = document.createElement("div");
    el.className = "chat-tool-result";
    const body = msg.body.length > 300 ? msg.body.slice(0, 300) + "..." : msg.body;

    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.className = "tool-result-summary";
    summary.textContent = "Tool result";
    const content = document.createElement("div");
    content.className = "tool-result-content";
    content.innerHTML = `<pre>${this.escapeHtml(body)}</pre>`;
    details.appendChild(summary);
    details.appendChild(content);
    el.appendChild(details);

    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  // -----------------------------------------------------------------------
  // Input handling
  // -----------------------------------------------------------------------

  private async sendMessage(): Promise<void> {
    const text = this.textareaEl.value.trim();
    if (!text || !this.ptyId) return;

    // Display user message as a bubble
    this.appendBubble({
      role: "user",
      content_type: "text",
      body: text,
    });

    // Send to PTY stdin as a line
    try {
      await invoke("write_pty", { id: this.ptyId, data: text + "\n" });
    } catch (e) {
      this.appendStatusBanner(`Send failed: ${e}`);
    }

    this.textareaEl.value = "";
    this.textareaEl.style.height = "auto";
  }

  // -----------------------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------------------

  private scrollToBottom(): void {
    if (this.userScrolled) return;
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }

  private escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}
