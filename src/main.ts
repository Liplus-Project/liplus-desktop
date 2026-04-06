import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

interface PaneState {
  terminal: Terminal;
  fitAddon: FitAddon;
  ptyId: string | null;
  command: string;
  unlistenData: UnlistenFn | null;
  unlistenExit: UnlistenFn | null;
}

const panes: Record<string, PaneState> = {};

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

  pane.terminal.writeln(`\x1b[36m[Starting ${pane.command}...]\x1b[0m`);

  try {
    const dims = pane.fitAddon.proposeDimensions() ?? { cols: 80, rows: 24 };
    const cols = dims.cols ?? 80;
    const rows = dims.rows ?? 24;

    const id = await invoke<string>("spawn_pty", {
      command: pane.command,
      args: [],
      cols,
      rows,
    });

    pane.ptyId = id;

    // Listen for PTY output
    pane.unlistenData = await listen<string>(`pty-data-${id}`, (event) => {
      pane.terminal.write(event.payload);
    });

    // Listen for PTY exit
    pane.unlistenExit = await listen<null>(`pty-exit-${id}`, () => {
      pane.terminal.writeln("\r\n\x1b[33m[Process exited]\x1b[0m");
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
  } catch (e) {
    pane.terminal.writeln(`\r\n\x1b[31m[Stop failed: ${e}]\x1b[0m`);
  }
  cleanupPane(paneId);
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

window.addEventListener("DOMContentLoaded", () => {
  const left = createTerminal("terminal-left");
  panes["left"] = {
    ...left,
    ptyId: null,
    command: "claude",
    unlistenData: null,
    unlistenExit: null,
  };

  const right = createTerminal("terminal-right");
  panes["right"] = {
    ...right,
    ptyId: null,
    command: "codex",
    unlistenData: null,
    unlistenExit: null,
  };

  panes["left"].terminal.writeln("\x1b[36mLi+ Desktop — Claude Code pane\x1b[0m");
  panes["left"].terminal.writeln("Press \x1b[32mStart\x1b[0m to launch Claude Code CLI.\r\n");

  panes["right"].terminal.writeln("\x1b[36mLi+ Desktop — Codex pane\x1b[0m");
  panes["right"].terminal.writeln("Press \x1b[32mStart\x1b[0m to launch Codex CLI.\r\n");

  document.querySelectorAll(".pane-btn").forEach((btn) => {
    const el = btn as HTMLButtonElement;
    const action = el.dataset.action!;
    const paneId = el.dataset.pane!;
    el.addEventListener("click", () => {
      if (action === "start") startProcess(paneId);
      else if (action === "stop") stopProcess(paneId);
    });
  });

  setupDivider();

  window.addEventListener("resize", () => {
    Object.values(panes).forEach((p) => p.fitAddon.fit());
  });
});
