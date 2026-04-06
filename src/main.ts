import "./styles.css";
import { TabManager, AppConfig } from "./tabs";
import { invoke } from "@tauri-apps/api/core";

function closeSettingsModal() {
  const modal = document.getElementById("settings-modal")!;
  modal.style.display = "none";
}

window.addEventListener("DOMContentLoaded", async () => {
  const tabBarEl = document.getElementById("tab-bar")!;
  const contentAreaEl = document.getElementById("tab-content-area")!;

  const manager = new TabManager(tabBarEl, contentAreaEl);

  // Persist config on change
  manager.onConfigChange = async (config: AppConfig) => {
    try {
      await invoke("save_config", { config });
    } catch (e) {
      console.error("Failed to save config:", e);
    }
  };

  // Load persisted config (falls back to defaults on first run)
  let appConfig: AppConfig;
  try {
    appConfig = await invoke<AppConfig>("load_config");
  } catch (e) {
    console.error("Failed to load config, using defaults:", e);
    appConfig = {
      tabs: [
        {
          id: "tab-1",
          name: "Claude Code",
          command: "claude",
          args: [],
          cwd: null,
          cli_kind: "claude",
        },
        {
          id: "tab-2",
          name: "Codex",
          command: "codex",
          args: [],
          cwd: null,
          cli_kind: "codex",
        },
      ],
    };
  }

  manager.loadTabs(appConfig);

  // Modal button handlers
  document
    .getElementById("modal-close")!
    .addEventListener("click", closeSettingsModal);
  document
    .getElementById("settings-cancel")!
    .addEventListener("click", closeSettingsModal);
  document
    .getElementById("settings-save")!
    .addEventListener("click", () => manager.saveFromModal());

  // Close modal on overlay click
  document
    .getElementById("settings-modal")!
    .addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeSettingsModal();
    });

  // Keyboard shortcuts in modal
  document
    .getElementById("settings-modal")!
    .addEventListener("keydown", (e) => {
      if (e.key === "Enter") manager.saveFromModal();
      if (e.key === "Escape") closeSettingsModal();
    });
});
