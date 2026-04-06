import "./styles.css";
import { ChatPane } from "./chat";
import { invoke } from "@tauri-apps/api/core";

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
  chat: ChatPane;
  config: PaneConfig;
}

const panes: Record<string, PaneState> = {};

type AgentStatus = "stopped" | "running" | "error";

function setStatus(paneId: string, status: AgentStatus) {
  const badge = document.getElementById(`status-${paneId}`);
  if (!badge) return;
  badge.className = `status-badge status-${status}`;
  badge.textContent = status.charAt(0).toUpperCase() + status.slice(1);

  // Update button disabled states
  const startBtn = document.querySelector(
    `.pane-btn[data-action="start"][data-pane="${paneId}"]`,
  ) as HTMLButtonElement | null;
  const stopBtn = document.querySelector(
    `.pane-btn[data-action="stop"][data-pane="${paneId}"]`,
  ) as HTMLButtonElement | null;
  if (startBtn) startBtn.disabled = status === "running";
  if (stopBtn) stopBtn.disabled = status !== "running";
}

// Currently open settings modal target
let settingsTargetPane: string | null = null;

async function startProcess(paneId: string) {
  const pane = panes[paneId];
  if (!pane) return;
  if (pane.chat.getPtyId()) {
    pane.chat.appendStatusBanner("Already running");
    return;
  }

  const { command, args, cwd } = pane.config;
  pane.chat.clear();
  pane.chat.appendStatusBanner(`Starting ${command}...`);

  try {
    // Use spawn_stream_pty for structured chat messages
    // Determine cli_kind from command name
    const cliKind = command.toLowerCase().includes("codex") ? "codex" : "claude";

    const id = await invoke<string>("spawn_stream_pty", {
      command,
      args,
      cols: 120,
      rows: 40,
      cwd: cwd ?? null,
      cliKind,
    });

    setStatus(paneId, "running");
    await pane.chat.attach(id);
  } catch (e) {
    pane.chat.appendStatusBanner(`Failed to start: ${e}`);
    setStatus(paneId, "error");
  }
}

async function stopProcess(paneId: string) {
  const pane = panes[paneId];
  if (!pane) return;
  const id = pane.chat.getPtyId();
  if (!id) return;

  try {
    await invoke("kill_pty", { id });
    pane.chat.appendStatusBanner("Stopped");
    setStatus(paneId, "stopped");
  } catch (e) {
    pane.chat.appendStatusBanner(`Stop failed: ${e}`);
  }
  pane.chat.detach();
}

function openSettingsModal(paneId: string) {
  const pane = panes[paneId];
  if (!pane) return;
  settingsTargetPane = paneId;

  const modal = document.getElementById("settings-modal")!;
  const cmdInput = document.getElementById(
    "settings-command",
  ) as HTMLInputElement;
  const argsInput = document.getElementById(
    "settings-args",
  ) as HTMLInputElement;
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

  const cmdInput = document.getElementById(
    "settings-command",
  ) as HTMLInputElement;
  const argsInput = document.getElementById(
    "settings-args",
  ) as HTMLInputElement;
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

  divider.addEventListener("mousedown", () => {
    dragging = true;
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const container = document.getElementById("panes")!;
    const rect = container.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const clamped = Math.max(0.2, Math.min(0.8, ratio));
    leftPane.style.flex = `${clamped}`;
    rightPane.style.flex = `${1 - clamped}`;
  });
  document.addEventListener("mouseup", () => {
    dragging = false;
  });
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

  const leftChat = new ChatPane("chat-left");
  panes["left"] = {
    chat: leftChat,
    config: appConfig.left,
  };

  const rightChat = new ChatPane("chat-right");
  panes["right"] = {
    chat: rightChat,
    config: appConfig.right,
  };

  leftChat.appendStatusBanner(
    "Li+ Desktop \u2014 Claude Code pane. Press Start to launch.",
  );
  rightChat.appendStatusBanner(
    "Li+ Desktop \u2014 Codex pane. Press Start to launch.",
  );

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
  document
    .getElementById("modal-close")!
    .addEventListener("click", closeSettingsModal);
  document
    .getElementById("settings-cancel")!
    .addEventListener("click", closeSettingsModal);
  document
    .getElementById("settings-save")!
    .addEventListener("click", saveSettings);

  // Close modal on overlay click
  document
    .getElementById("settings-modal")!
    .addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeSettingsModal();
    });

  // Save on Enter key
  document
    .getElementById("settings-modal")!
    .addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveSettings();
      if (e.key === "Escape") closeSettingsModal();
    });

  setupDivider();
});
