import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types — mirrors Rust TabSessions / SessionData
// ---------------------------------------------------------------------------

export interface SessionData {
  id: string;
  name: string;
  messages: unknown[]; // kept for serialization compat, always empty for terminal mode
}

export interface TabSessions {
  tab_id: string;
  active_session_id: string | null;
  sessions: SessionData[];
}

// ---------------------------------------------------------------------------
// SessionManager — sidebar UI + session CRUD for one tab
// ---------------------------------------------------------------------------

export class SessionManager {
  private tabId: string;
  private sessions: SessionData[] = [];
  private activeSessionId: string | null = null;
  private sidebarEl: HTMLElement;
  private listEl: HTMLElement;
  private collapsed = false;
  private nextSessionNum = 1;

  /** Callback when sessions change (for persistence). */
  onSessionsChange: (() => void) | null = null;

  constructor(tabId: string, parentEl: HTMLElement) {
    this.tabId = tabId;

    // Build sidebar DOM
    this.sidebarEl = document.createElement("div");
    this.sidebarEl.className = "session-sidebar";

    const header = document.createElement("div");
    header.className = "session-sidebar-header";

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "session-toggle-btn";
    toggleBtn.innerHTML = "&#9776;";
    toggleBtn.title = "Toggle sidebar";
    toggleBtn.addEventListener("click", () => this.toggleSidebar());

    const title = document.createElement("span");
    title.className = "session-sidebar-title";
    title.textContent = "Sessions";

    const newBtn = document.createElement("button");
    newBtn.className = "session-new-btn";
    newBtn.textContent = "+";
    newBtn.title = "New session";
    newBtn.addEventListener("click", () => this.createSession());

    header.appendChild(toggleBtn);
    header.appendChild(title);
    header.appendChild(newBtn);

    this.listEl = document.createElement("div");
    this.listEl.className = "session-list";

    this.sidebarEl.appendChild(header);
    this.sidebarEl.appendChild(this.listEl);

    // Insert sidebar as the first child of the parent container
    parentEl.insertBefore(this.sidebarEl, parentEl.firstChild);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Get the sidebar element (for external layout). */
  getElement(): HTMLElement {
    return this.sidebarEl;
  }

  /** Export session data for persistence. */
  exportData(): TabSessions {
    return {
      tab_id: this.tabId,
      active_session_id: this.activeSessionId,
      sessions: this.sessions.map((s) => ({ ...s, messages: [] })),
    };
  }

  /** Import session data from persistence. */
  importData(data: TabSessions): void {
    this.sessions = data.sessions;
    this.activeSessionId = data.active_session_id;

    // Track next session number
    const nums = this.sessions
      .map((s) => {
        const m = s.id.match(/^session-(\d+)$/);
        return m ? parseInt(m[1], 10) : 0;
      })
      .filter((n) => n > 0);
    this.nextSessionNum = nums.length > 0 ? Math.max(...nums) + 1 : 1;

    this.renderList();
  }

  /** Create a default session if none exist. */
  ensureDefaultSession(): void {
    if (this.sessions.length === 0) {
      this.createSession();
    }
  }

  /** Get the active session ID. */
  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  // -----------------------------------------------------------------------
  // Session lifecycle
  // -----------------------------------------------------------------------

  createSession(name?: string): void {
    const id = `session-${this.nextSessionNum++}`;
    const sessionName = name || `Session ${this.sessions.length + 1}`;
    const session: SessionData = { id, name: sessionName, messages: [] };

    this.sessions.push(session);
    this.activeSessionId = id;
    this.renderList();
    this.notifyChange();
  }

  private switchTo(sessionId: string): void {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;

    this.activeSessionId = sessionId;
    this.renderList();
  }

  private deleteSession(sessionId: string): void {
    const idx = this.sessions.findIndex((s) => s.id === sessionId);
    if (idx < 0) return;

    this.sessions.splice(idx, 1);

    if (this.activeSessionId === sessionId) {
      // Switch to the nearest session or create a new one
      if (this.sessions.length > 0) {
        const newIdx = Math.min(idx, this.sessions.length - 1);
        this.activeSessionId = null;
        this.switchTo(this.sessions[newIdx].id);
      } else {
        this.activeSessionId = null;
        this.createSession();
        return;
      }
    }

    this.renderList();
    this.notifyChange();
  }

  private renameSession(sessionId: string, newName: string): void {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (session) {
      session.name = newName.trim() || session.name;
      this.renderList();
      this.notifyChange();
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private toggleSidebar(): void {
    this.collapsed = !this.collapsed;
    this.sidebarEl.classList.toggle("session-sidebar-collapsed", this.collapsed);
  }

  private notifyChange(): void {
    if (this.onSessionsChange) {
      this.onSessionsChange();
    }
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  private renderList(): void {
    this.listEl.innerHTML = "";

    for (const session of this.sessions) {
      const item = document.createElement("div");
      item.className = "session-item";
      if (session.id === this.activeSessionId) {
        item.classList.add("session-active");
      }

      const nameSpan = document.createElement("span");
      nameSpan.className = "session-name";
      nameSpan.textContent = session.name;
      nameSpan.title = session.name;

      // Double-click to rename
      nameSpan.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        this.startRename(session.id, nameSpan);
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "session-delete-btn";
      deleteBtn.textContent = "\u00d7";
      deleteBtn.title = "Delete session";
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.deleteSession(session.id);
      });

      item.appendChild(nameSpan);
      item.appendChild(deleteBtn);

      item.addEventListener("click", () => {
        if (session.id !== this.activeSessionId) {
          this.switchTo(session.id);
          this.notifyChange();
        }
      });

      this.listEl.appendChild(item);
    }
  }

  private startRename(sessionId: string, nameSpan: HTMLElement): void {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;

    const input = document.createElement("input");
    input.className = "session-rename-input";
    input.type = "text";
    input.value = session.name;

    const commit = () => {
      const newName = input.value.trim();
      if (newName) {
        this.renameSession(sessionId, newName);
      } else {
        this.renderList();
      }
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
      if (e.key === "Escape") {
        input.removeEventListener("blur", commit);
        this.renderList();
      }
    });

    nameSpan.replaceWith(input);
    input.focus();
    input.select();
  }
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

export async function saveAllSessions(
  managers: Map<string, SessionManager>,
): Promise<void> {
  const data: TabSessions[] = [];
  for (const [, mgr] of managers) {
    data.push(mgr.exportData());
  }
  try {
    await invoke("save_sessions", { data });
  } catch (e) {
    console.error("Failed to save sessions:", e);
  }
}

export async function loadAllSessions(): Promise<TabSessions[]> {
  try {
    return await invoke<TabSessions[]>("load_sessions");
  } catch (e) {
    console.error("Failed to load sessions:", e);
    return [];
  }
}
