import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Command } from "@tauri-apps/plugin-shell";

interface PaneState {
  terminal: Terminal;
  fitAddon: FitAddon;
  process: Awaited<ReturnType<Command<string>["spawn"]>> | null;
  command: string;
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
    convertEol: true,
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
  if (pane.process) {
    pane.terminal.writeln("\r\n\x1b[33m[Already running]\x1b[0m");
    return;
  }

  pane.terminal.writeln(`\x1b[36m[Starting ${pane.command}...]\x1b[0m`);

  try {
    const cmd = Command.create("shell-cmd", ["/C", pane.command], {
      encoding: "utf-8",
    });

    cmd.stdout.on("data", (data: string) => {
      pane.terminal.write(data);
    });

    cmd.stderr.on("data", (data: string) => {
      pane.terminal.write(data);
    });

    cmd.on("close", (data: { code: number | null }) => {
      pane.terminal.writeln(`\r\n\x1b[33m[Exited: ${data.code}]\x1b[0m`);
      pane.process = null;
    });

    cmd.on("error", (error: string) => {
      pane.terminal.writeln(`\r\n\x1b[31m[Error: ${error}]\x1b[0m`);
      pane.process = null;
    });

    pane.process = await cmd.spawn();

    pane.terminal.onData((data: string) => {
      if (pane.process) {
        pane.process.write(data + "\n");
      }
    });
  } catch (e) {
    pane.terminal.writeln(`\r\n\x1b[31m[Failed to start: ${e}]\x1b[0m`);
  }
}

async function stopProcess(paneId: string) {
  const pane = panes[paneId];
  if (!pane?.process) return;
  try {
    await pane.process.kill();
    pane.process = null;
    pane.terminal.writeln("\r\n\x1b[33m[Stopped]\x1b[0m");
  } catch (e) {
    pane.terminal.writeln(`\r\n\x1b[31m[Stop failed: ${e}]\x1b[0m`);
  }
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
  panes["left"] = { ...left, process: null, command: "claude" };

  const right = createTerminal("terminal-right");
  panes["right"] = { ...right, process: null, command: "codex" };

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
