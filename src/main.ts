import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

interface PaneConfig {
  command: string;
  args: string[];
  cwd: string | null;
}

interface AppConfig {
  left: PaneConfig;
  right: PaneConfig;
}

interface PaneState {
  terminal: Terminal;
  fitAddon: FitAddon;
  ptyId: string | null;
  config: PaneConfig;
  unlistenData: UnlistenFn | null;
  unlistenExit: UnlistenFn | null;
}

const panes: Record<string, PaneState> = {};

type AgentStatus = "stopped" | "running" | "error";

function setStatus(paneId: string, status: AgentStatus) {
  const badge = document.getElementById(`status-${paneId}`);
  if (!badge) return;
  badge.className = `status-badge status-${status}`;
  badge.textContent = status.charAt(0).toUpperCase() + status.slice(1);

  // Update button disabled states
  const startBtn = document.querySelector(`.pane-btn[data-action="start"][data-pane="${paneId}"]`) as HTMLButtonElement | null;
  const stopBtn = document.querySelector(`.pane-btn[data-action="stop"][data-pane="${paneId}"]`) as HTMLButtonElement | null;
  if (startBtn) startBtn.disabled = status === "running";
  if (stopBtn) stopBtn.disabled = status !== "running";
}

// Currently open settings modal target
let settingsTargetPane: string | null = null;

function createTerminal(containerId: string): { terminal: Terminal; fitAddon: FitAddon } {
  const container = document.getElementById(containerId)!;
  const terminal = new Terminal({
    fontSize: 13,
    fontFamily: "'Cascadia Code', 'Consolas', monospace",
    theme: {
      background: "#0a0a1a",
      foreground: "#e0e0e0",
      cursor: "#64ffda",
      selectionBackground: "#0f346080",
    },
    cursorBlink: true,
    convertEol: false,
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  fitAddon.fit();
  return { terminal, fitAddon };
}

async function startProcess(paneId: string) {
  const pane = panes[paneId];
  if (!pane) return;
  if (pane.ptyId) {
    pane.terminal.writeln("\r\n\x1b[33m[Already running]\x1b[0m");
    return;
  }

  const { command, args, cwd } = pane.config;
  pane.terminal.writeln(`\x1b[36m[Starting ${command}...]\x1b[0m`);

  try {
    const dims = pane.fitAddon.proposeDimensions() ?? { cols: 80, rows: 24 };
    const cols = dims.cols ?? 80;
    const rows = dims.rows ?? 24;

    const id = await invoke<string>("spawn_pty", {
      command,
      args,
      cols,
      rows,
      cwd: cwd ?? null,
    });

    pane.ptyId = id;
    setStatus(paneId, "running");

    // Listen for PTY output
    pane.unlistenData = await listen<string>(`pty-data-${id}`, (event) => {
      pane.terminal.write(event.payload);
    });

    // Listen for PTY exit (payload is exit code or null)
    pane.unlistenExit = await listen<number | null>(`pty-exit-${id}`, (event) => {
      const code = event.payload;
      if (code !== null && code !== 0) {
        pane.terminal.writeln(`\r\n\x1b[31m[Exited with code ${code}]\x1b[0m`);
        setStatus(paneId, "error");
      } else {
        pane.terminal.writeln("\r\n\x1b[33m[Process exited]\x1b[0m");
        setStatus(paneId, "stopped");
      }
      cleanupPane(paneId);
    });

    // Forward terminal input to PTY
    pane.terminal.onData((data: string) => {
      if (pane.ptyId) {
        invoke("write_pty", { id: pane.ptyId, data }).catch(() => {});
      }
    });

    // Enable Ctrl+V paste from clipboard
    pane.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type === "keydown" && e.ctrlKey && e.key === "v") {
        navigator.clipboard.readText().then((text) => {
          if (pane.ptyId && text) {
            invoke("write_pty", { id: pane.ptyId, data: text }).catch(() => {});
          }
        });
        return false; // prevent xterm default handling
      }
      // Ctrl+C: let xterm handle it (sends SIGINT via PTY)
      return true;
    });

    // Forward terminal resize to PTY
    pane.terminal.onResize(({ cols, rows }) => {
      if (pane.ptyId) {
        invoke("resize_pty", { id: pane.ptyId, cols, rows }).catch(() => {});
      }
    });
  } catch (e) {
    pane.terminal.writeln(`\r\n\x1b[31m[Failed to start: ${e}]\x1b[0m`);
    setStatus(paneId, "error");
  }
}

function cleanupPane(paneId: string) {
  const pane = panes[paneId];
  if (!pane) return;
  pane.ptyId = null;
  if (pane.unlistenData) {
    pane.unlistenData();
    pane.unlistenData = null;
  }
  if (pane.unlistenExit) {
    pane.unlistenExit();
    pane.unlistenExit = null;
  }
}

async function stopProcess(paneId: string) {
  const pane = panes[paneId];
  if (!pane?.ptyId) return;
  const id = pane.ptyId;
  try {
    await invoke("kill_pty", { id });
    pane.terminal.writeln("\r\n\x1b[33m[Stopped]\x1b[0m");
    setStatus(paneId, "stopped");
  } catch (e) {
    pane.terminal.writeln(`\r\n\x1b[31m[Stop failed: ${e}]\x1b[0m`);
  }
  cleanupPane(paneId);
}

function openSettingsModal(paneId: string) {
  const pane = panes[paneId];
  if (!pane) return;
  settingsTargetPane = paneId;

  const modal = document.getElementById("settings-modal")!;
  const cmdInput = document.getElementById("settings-command") as HTMLInputElement;
  const argsInput = document.getElementById("settings-args") as HTMLInputElement;
  const cwdInput = document.getElementById("settings-cwd") as HTMLInputElement;

  cmdInput.value = pane.config.command;
  argsInput.value = pane.config.args.join(", ");
  cwdInput.value = pane.config.cwd ?? "";

  modal.style.display = "flex";
  cmdInput.focus();
}

function closeSettingsModal() {
  const modal = document.getElementById("settings-modal")!;
  modal.style.display = "none";
  settingsTargetPane = null;
}

async function saveSettings() {
  if (!settingsTargetPane) return;
  const pane = panes[settingsTargetPane];
  if (!pane) return;

  const cmdInput = document.getElementById("settings-command") as HTMLInputElement;
  const argsInput = document.getElementById("settings-args") as HTMLInputElement;
  const cwdInput = document.getElementById("settings-cwd") as HTMLInputElement;

  const command = cmdInput.value.trim();
  const args = argsInput.value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const cwd = cwdInput.value.trim() || null;

  if (!command) return;

  pane.config = { command, args, cwd };

  // Build full config and persist
  const config: AppConfig = {
    left: panes["left"].config,
    right: panes["right"].config,
  };

  try {
    await invoke("save_config", { config });
  } catch (e) {
    console.error("Failed to save config:", e);
  }

  closeSettingsModal();
}

function setupDivider() {
  const divider = document.getElementById("divider")!;
  const leftPane = document.getElementById("pane-left")!;
  const rightPane = document.getElementById("pane-right")!;
  let dragging = false;

  divider.addEventListener("mousedown", () => { dragging = true; });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const container = document.getElementById("panes")!;
    const rect = container.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const clamped = Math.max(0.2, Math.min(0.8, ratio));
    leftPane.style.flex = `${clamped}`;
    rightPane.style.flex = `${1 - clamped}`;
    Object.values(panes).forEach((p) => p.fitAddon.fit());
  });
  document.addEventListener("mouseup", () => { dragging = false; });
}

window.addEventListener("DOMContentLoaded", async () => {
  // Load persisted config (falls back to defaults on first run)
  let appConfig: AppConfig;
  try {
    appConfig = await invoke<AppConfig>("load_config");
  } catch (e) {
    console.error("Failed to load config, using defaults:", e);
    appConfig = {
      left: { command: "claude", args: [], cwd: null },
      right: { command: "codex", args: [], cwd: null },
    };
  }

  const left = createTerminal("terminal-left");
  panes["left"] = {
    ...left,
    ptyId: null,
    config: appConfig.left,
    unlistenData: null,
    unlistenExit: null,
  };

  const right = createTerminal("terminal-right");
  panes["right"] = {
    ...right,
    ptyId: null,
    config: appConfig.right,
    unlistenData: null,
    unlistenExit: null,
  };

  panes["left"].terminal.writeln("\x1b[36mLi+ Desktop — Claude Code pane\x1b[0m");
  panes["left"].terminal.writeln("Press \x1b[32mStart\x1b[0m to launch Claude Code CLI.\r\n");

  panes["right"].terminal.writeln("\x1b[36mLi+ Desktop — Codex pane\x1b[0m");
  panes["right"].terminal.writeln("Press \x1b[32mStart\x1b[0m to launch Codex CLI.\r\n");

  // Set initial button states
  setStatus("left", "stopped");
  setStatus("right", "stopped");

  // Pane button handlers
  document.querySelectorAll(".pane-btn").forEach((btn) => {
    const el = btn as HTMLButtonElement;
    const action = el.dataset.action!;
    const paneId = el.dataset.pane!;
    el.addEventListener("click", () => {
      if (action === "start") startProcess(paneId);
      else if (action === "stop") stopProcess(paneId);
      else if (action === "settings") openSettingsModal(paneId);
    });
  });

  // Modal button handlers
  document.getElementById("modal-close")!.addEventListener("click", closeSettingsModal);
  document.getElementById("settings-cancel")!.addEventListener("click", closeSettingsModal);
  document.getElementById("settings-save")!.addEventListener("click", saveSettings);

  // Close modal on overlay click
  document.getElementById("settings-modal")!.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeSettingsModal();
  });

  // Save on Enter key
  document.getElementById("settings-modal")!.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveSettings();
    if (e.key === "Escape") closeSettingsModal();
  });

  setupDivider();

  window.addEventListener("resize", () => {
    Object.values(panes).forEach((p) => p.fitAddon.fit());
  });
});
