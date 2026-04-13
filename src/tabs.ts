import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SessionManager, loadAllSessions } from "./sessions";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Types — mirrors Rust TabConfig
// ---------------------------------------------------------------------------

export interface TabConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string | null;
  cli_kind: string;
}

export interface AppConfig {
  tabs: TabConfig[];
}

export type AgentStatus = "stopped" | "running" | "error";

// ---------------------------------------------------------------------------
// TabState — one tab's runtime state
// ---------------------------------------------------------------------------

interface TabState {
  config: TabConfig;
  terminal: Terminal;
  fitAddon: FitAddon;
  sessionMgr: SessionManager;
  containerEl: HTMLElement;
  terminalContainerEl: HTMLElement;
  tabEl: HTMLElement;
  status: AgentStatus;
  ptyId: string | null;
  unlistenData: UnlistenFn | null;
  unlistenExit: UnlistenFn | null;
  resizeObserver: ResizeObserver | null;
}

// ---------------------------------------------------------------------------
// TabManager — owns the tab bar and all tab instances
// ---------------------------------------------------------------------------

export class TabManager {
  private tabs: Map<string, TabState> = new Map();
  private activeTabId: string | null = null;
  private tabBarEl: HTMLElement;
  private contentAreaEl: HTMLElement;
  private nextTabNum = 1;
  private sessionManagers: Map<string, SessionManager> = new Map();

  /** Callback when config changes (for persistence). */
  onConfigChange: ((config: AppConfig) => void) | null = null;
  /** Callback when session data changes (for persistence). */
  onSessionsChange: (() => void) | null = null;

  constructor(tabBarEl: HTMLElement, contentAreaEl: HTMLElement) {
    this.tabBarEl = tabBarEl;
    this.contentAreaEl = contentAreaEl;

    // Add-tab button
    const addBtn = document.createElement("button");
    addBtn.className = "tab-add-btn";
    addBtn.textContent = "+";
    addBtn.title = "Add agent tab";
    addBtn.addEventListener("click", () => this.openAddDialog());
    this.tabBarEl.appendChild(addBtn);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Load tabs from persisted config, then restore sessions. */
  async loadTabs(config: AppConfig): Promise<void> {
    for (const tabCfg of config.tabs) {
      this.createTab(tabCfg, false);
    }
    // Activate first tab
    if (config.tabs.length > 0) {
      this.activateTab(config.tabs[0].id);
    }
    // Track next id number
    const nums = config.tabs
      .map((t) => {
        const m = t.id.match(/^tab-(\d+)$/);
        return m ? parseInt(m[1], 10) : 0;
      })
      .filter((n) => n > 0);
    this.nextTabNum = nums.length > 0 ? Math.max(...nums) + 1 : 1;

    // Restore session data
    const allSessions = await loadAllSessions();
    for (const tabSessions of allSessions) {
      const mgr = this.sessionManagers.get(tabSessions.tab_id);
      if (mgr) {
        mgr.importData(tabSessions);
      }
    }

    // Ensure each tab has at least one session
    for (const [, mgr] of this.sessionManagers) {
      mgr.ensureDefaultSession();
    }
  }

  /** Get all session managers (for persistence). */
  getSessionManagers(): Map<string, SessionManager> {
    return this.sessionManagers;
  }

  /** Get the current config for persistence. */
  getConfig(): AppConfig {
    const tabs: TabConfig[] = [];
    // Preserve DOM order
    const tabEls = this.tabBarEl.querySelectorAll<HTMLElement>(".tab-item");
    for (const el of tabEls) {
      const id = el.dataset.tabId;
      if (id) {
        const state = this.tabs.get(id);
        if (state) tabs.push({ ...state.config });
      }
    }
    return { tabs };
  }

  /** Start the process for a tab. */
  async startTab(tabId: string): Promise<void> {
    const state = this.tabs.get(tabId);
    if (!state) return;
    if (state.ptyId) return; // Already running

    const { command, args, cwd } = state.config;

    // Clear terminal for fresh start
    state.terminal.clear();

    // Spawn PTY — pass user's configured args only, no stream-json flags
    try {
      const cols = state.terminal.cols;
      const rows = state.terminal.rows;
      const id = await invoke<string>("spawn_pty", {
        command,
        args,
        cols,
        rows,
        cwd: cwd ?? null,
      });

      state.ptyId = id;
      this.setStatus(tabId, "running");

      // Listen for PTY output
      state.unlistenData = await listen<string>(
        `pty-data-${id}`,
        (event) => {
          state.terminal.write(event.payload);
        },
      );

      // Listen for PTY exit
      state.unlistenExit = await listen<number | null>(
        `pty-exit-${id}`,
        (event) => {
          const code = event.payload;
          const msg =
            code !== null && code !== 0
              ? `\r\n[Process exited with code ${code}]`
              : "\r\n[Process exited]";
          state.terminal.write(msg);
          this.detachPty(tabId);
          this.setStatus(tabId, "stopped");
        },
      );

      // Initial fit after attach
      setTimeout(() => {
        state.fitAddon.fit();
      }, 50);
    } catch (e) {
      state.terminal.write(`\r\nFailed to start: ${e}\r\n`);
      this.setStatus(tabId, "error");
    }
  }

  /** Stop the process for a tab. */
  async stopTab(tabId: string): Promise<void> {
    const state = this.tabs.get(tabId);
    if (!state) return;
    if (!state.ptyId) return;

    try {
      await invoke("kill_pty", { id: state.ptyId });
      state.terminal.write("\r\n[Stopped]");
      this.setStatus(tabId, "stopped");
    } catch (e) {
      state.terminal.write(`\r\n[Stop failed: ${e}]`);
    }
    this.detachPty(tabId);
  }

  // -----------------------------------------------------------------------
  // PTY lifecycle helpers
  // -----------------------------------------------------------------------

  private detachPty(tabId: string): void {
    const state = this.tabs.get(tabId);
    if (!state) return;
    state.ptyId = null;
    if (state.unlistenData) {
      state.unlistenData();
      state.unlistenData = null;
    }
    if (state.unlistenExit) {
      state.unlistenExit();
      state.unlistenExit = null;
    }
  }

  // -----------------------------------------------------------------------
  // Tab lifecycle
  // -----------------------------------------------------------------------

  private createTab(cfg: TabConfig, activate: boolean): void {
    // Tab content wrapper (hidden by default) — flex row for sidebar + terminal
    const containerEl = document.createElement("div");
    containerEl.className = "tab-content";
    containerEl.dataset.tabId = cfg.id;
    containerEl.style.display = "none";
    this.contentAreaEl.appendChild(containerEl);

    // Terminal container (right side of the flex row)
    const terminalContainerEl = document.createElement("div");
    terminalContainerEl.className = "terminal-container";
    containerEl.appendChild(terminalContainerEl);

    // Create xterm.js terminal
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      theme: { background: "#0a0a1a" },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    // SessionManager builds sidebar and inserts it before terminalContainerEl
    const sessionMgr = new SessionManager(cfg.id, containerEl);
    sessionMgr.onSessionsChange = () => {
      if (this.onSessionsChange) {
        this.onSessionsChange();
      }
    };
    this.sessionManagers.set(cfg.id, sessionMgr);

    // Open terminal into the container element
    terminal.open(terminalContainerEl);

    // ResizeObserver to auto-fit terminal on container resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(terminalContainerEl);

    // Tab bar item
    const tabEl = document.createElement("div");
    tabEl.className = "tab-item";
    tabEl.dataset.tabId = cfg.id;
    tabEl.draggable = true;

    const nameSpan = document.createElement("span");
    nameSpan.className = "tab-name";
    nameSpan.textContent = cfg.name;

    const statusSpan = document.createElement("span");
    statusSpan.className = "tab-status-dot status-dot-stopped";
    statusSpan.dataset.tabId = cfg.id;

    const closeBtn = document.createElement("button");
    closeBtn.className = "tab-close-btn";
    closeBtn.textContent = "\u00d7";
    closeBtn.title = "Close tab";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeTab(cfg.id);
    });

    tabEl.appendChild(statusSpan);
    tabEl.appendChild(nameSpan);
    tabEl.appendChild(closeBtn);

    tabEl.addEventListener("click", () => this.activateTab(cfg.id));
    tabEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openSettingsDialog(cfg.id);
    });

    // Drag & drop reorder
    tabEl.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("text/plain", cfg.id);
      tabEl.classList.add("tab-dragging");
    });
    tabEl.addEventListener("dragend", () => {
      tabEl.classList.remove("tab-dragging");
    });
    tabEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      tabEl.classList.add("tab-dragover");
    });
    tabEl.addEventListener("dragleave", () => {
      tabEl.classList.remove("tab-dragover");
    });
    tabEl.addEventListener("drop", (e) => {
      e.preventDefault();
      tabEl.classList.remove("tab-dragover");
      const draggedId = e.dataTransfer?.getData("text/plain");
      if (draggedId && draggedId !== cfg.id) {
        this.reorderTab(draggedId, cfg.id);
      }
    });

    // Insert before the "+" button
    const addBtn = this.tabBarEl.querySelector(".tab-add-btn");
    this.tabBarEl.insertBefore(tabEl, addBtn);

    const tabState: TabState = {
      config: cfg,
      terminal,
      fitAddon,
      sessionMgr,
      containerEl,
      terminalContainerEl,
      tabEl,
      status: "stopped",
      ptyId: null,
      unlistenData: null,
      unlistenExit: null,
      resizeObserver,
    };

    // Register input/resize handlers ONCE per terminal (not per start)
    terminal.onData((data) => {
      if (tabState.ptyId) {
        invoke("write_pty", { id: tabState.ptyId, data });
      }
    });
    terminal.onResize(({ cols, rows }) => {
      if (tabState.ptyId) {
        invoke("resize_pty", { id: tabState.ptyId, cols, rows });
      }
    });

    this.tabs.set(cfg.id, tabState);

    if (activate) {
      this.activateTab(cfg.id);
    }
  }

  private activateTab(tabId: string): void {
    if (this.activeTabId === tabId) return;

    // Deactivate current
    if (this.activeTabId) {
      const prev = this.tabs.get(this.activeTabId);
      if (prev) {
        prev.containerEl.style.display = "none";
        prev.tabEl.classList.remove("tab-active");
      }
    }

    // Activate new
    const state = this.tabs.get(tabId);
    if (state) {
      state.containerEl.style.display = "flex";
      state.tabEl.classList.add("tab-active");
      this.activeTabId = tabId;
      this.updateToolbar(state);
      // Re-fit terminal after it becomes visible
      setTimeout(() => {
        state.fitAddon.fit();
      }, 50);
    }
  }

  private async closeTab(tabId: string): Promise<void> {
    const state = this.tabs.get(tabId);
    if (!state) return;

    // Kill PTY if running
    if (state.ptyId) {
      try {
        await invoke("kill_pty", { id: state.ptyId });
      } catch (_) {
        // ignore
      }
      this.detachPty(tabId);
    }

    // Cleanup
    if (state.resizeObserver) {
      state.resizeObserver.disconnect();
    }
    state.terminal.dispose();

    // Remove DOM and session manager
    state.tabEl.remove();
    state.containerEl.remove();
    this.tabs.delete(tabId);
    this.sessionManagers.delete(tabId);

    // If the closed tab was active, switch to the first remaining
    if (this.activeTabId === tabId) {
      this.activeTabId = null;
      const firstTab = this.tabBarEl.querySelector<HTMLElement>(".tab-item");
      if (firstTab?.dataset.tabId) {
        this.activateTab(firstTab.dataset.tabId);
      } else {
        this.updateToolbar(null);
      }
    }

    this.persistConfig();
  }

  private reorderTab(draggedId: string, targetId: string): void {
    const draggedState = this.tabs.get(draggedId);
    const targetState = this.tabs.get(targetId);
    if (!draggedState || !targetState) return;

    // Move in DOM
    this.tabBarEl.insertBefore(draggedState.tabEl, targetState.tabEl);
    this.persistConfig();
  }

  // -----------------------------------------------------------------------
  // Status management
  // -----------------------------------------------------------------------

  private setStatus(tabId: string, status: AgentStatus): void {
    const state = this.tabs.get(tabId);
    if (!state) return;
    state.status = status;

    // Update dot indicator
    const dot = state.tabEl.querySelector<HTMLElement>(".tab-status-dot");
    if (dot) {
      dot.className = `tab-status-dot status-dot-${status}`;
    }

    // Update toolbar if this is the active tab
    if (this.activeTabId === tabId) {
      this.updateToolbar(state);
    }
  }

  // -----------------------------------------------------------------------
  // Toolbar — shown above the content area for the active tab
  // -----------------------------------------------------------------------

  private updateToolbar(state: TabState | null): void {
    const toolbar = document.getElementById("tab-toolbar");
    if (!toolbar) return;

    if (!state) {
      toolbar.innerHTML = "";
      return;
    }

    toolbar.innerHTML = "";

    const label = document.createElement("span");
    label.className = "toolbar-label";
    label.textContent = state.config.name;

    const badge = document.createElement("span");
    badge.className = `status-badge status-${state.status}`;
    badge.textContent =
      state.status.charAt(0).toUpperCase() + state.status.slice(1);

    const startBtn = document.createElement("button");
    startBtn.className = "pane-btn";
    startBtn.textContent = "Start";
    startBtn.disabled = state.status === "running";
    startBtn.addEventListener("click", () => this.startTab(state.config.id));

    const stopBtn = document.createElement("button");
    stopBtn.className = "pane-btn";
    stopBtn.textContent = "Stop";
    stopBtn.disabled = state.status !== "running";
    stopBtn.addEventListener("click", () => this.stopTab(state.config.id));

    const settingsBtn = document.createElement("button");
    settingsBtn.className = "pane-btn pane-settings-btn";
    settingsBtn.textContent = "\u2699";
    settingsBtn.addEventListener("click", () =>
      this.openSettingsDialog(state.config.id),
    );

    toolbar.appendChild(label);
    toolbar.appendChild(badge);
    toolbar.appendChild(startBtn);
    toolbar.appendChild(stopBtn);
    toolbar.appendChild(settingsBtn);
  }

  // -----------------------------------------------------------------------
  // Dialogs
  // -----------------------------------------------------------------------

  private openAddDialog(): void {
    this.showSettingsModal(null);
  }

  private openSettingsDialog(tabId: string): void {
    this.showSettingsModal(tabId);
  }

  private showSettingsModal(tabId: string | null): void {
    const modal = document.getElementById("settings-modal")!;
    const titleEl = modal.querySelector(".modal-title") as HTMLElement;
    const nameInput = document.getElementById(
      "settings-name",
    ) as HTMLInputElement;
    const cmdInput = document.getElementById(
      "settings-command",
    ) as HTMLInputElement;
    const argsInput = document.getElementById(
      "settings-args",
    ) as HTMLInputElement;
    const cwdInput = document.getElementById(
      "settings-cwd",
    ) as HTMLInputElement;
    const kindSelect = document.getElementById(
      "settings-cli-kind",
    ) as HTMLSelectElement;

    if (tabId) {
      const state = this.tabs.get(tabId);
      if (!state) return;
      titleEl.textContent = "Tab Settings";
      nameInput.value = state.config.name;
      cmdInput.value = state.config.command;
      argsInput.value = state.config.args.join(", ");
      cwdInput.value = state.config.cwd ?? "";
      kindSelect.value = state.config.cli_kind;
    } else {
      titleEl.textContent = "New Agent Tab";
      nameInput.value = "";
      cmdInput.value = "";
      argsInput.value = "";
      cwdInput.value = "";
      kindSelect.value = "claude";
    }

    modal.dataset.editTabId = tabId ?? "";
    modal.style.display = "flex";
    nameInput.focus();
  }

  /** Called from main when the modal save button is clicked. */
  saveFromModal(): void {
    const modal = document.getElementById("settings-modal")!;
    const editTabId = modal.dataset.editTabId || null;

    const nameInput = document.getElementById(
      "settings-name",
    ) as HTMLInputElement;
    const cmdInput = document.getElementById(
      "settings-command",
    ) as HTMLInputElement;
    const argsInput = document.getElementById(
      "settings-args",
    ) as HTMLInputElement;
    const cwdInput = document.getElementById(
      "settings-cwd",
    ) as HTMLInputElement;
    const kindSelect = document.getElementById(
      "settings-cli-kind",
    ) as HTMLSelectElement;

    const name = nameInput.value.trim() || "Untitled";
    const command = cmdInput.value.trim();
    const args = argsInput.value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const cwd = cwdInput.value.trim() || null;
    const cli_kind = kindSelect.value;

    if (!command) return;

    if (editTabId) {
      // Update existing tab
      const state = this.tabs.get(editTabId);
      if (state) {
        state.config.name = name;
        state.config.command = command;
        state.config.args = args;
        state.config.cwd = cwd;
        state.config.cli_kind = cli_kind;
        // Update tab label
        const nameSpan = state.tabEl.querySelector(".tab-name");
        if (nameSpan) nameSpan.textContent = name;
        // Update toolbar if active
        if (this.activeTabId === editTabId) {
          this.updateToolbar(state);
        }
      }
    } else {
      // Create new tab
      const id = `tab-${this.nextTabNum++}`;
      this.createTab({ id, name, command, args, cwd, cli_kind }, true);
    }

    modal.style.display = "none";
    this.persistConfig();
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  private persistConfig(): void {
    if (this.onConfigChange) {
      this.onConfigChange(this.getConfig());
    }
  }
}
