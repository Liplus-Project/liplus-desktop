use parking_lot::Mutex;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::stream_parser::{self, CliKind};

struct PtyInstance {
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send>,
    killer: Box<dyn portable_pty::MasterPty + Send>,
}

type PtyMap = Arc<Mutex<HashMap<String, PtyInstance>>>;

#[derive(Clone)]
pub struct PtyState {
    ptys: PtyMap,
}

impl PtyState {
    pub fn new() -> Self {
        PtyState {
            ptys: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[tauri::command]
pub fn spawn_pty(
    app: AppHandle,
    state: tauri::State<PtyState>,
    command: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<String, String> {
    let pty_system = NativePtySystem::default();

    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    // On Windows, .cmd/.bat scripts (like npm-installed CLIs) cannot be spawned directly.
    // Wrap them with cmd.exe /C so Windows resolves the command via PATH and PATHEXT.
    let mut cmd = if cfg!(windows) {
        let mut c = CommandBuilder::new("cmd.exe");
        c.arg("/C");
        c.arg(&command);
        for arg in &args {
            c.arg(arg);
        }
        c
    } else {
        let mut c = CommandBuilder::new(&command);
        for arg in &args {
            c.arg(arg);
        }
        c
    };

    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }

    // Spawn the child process in the PTY
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn '{command}': {e}"))?;

    // Get writer (stdin to the PTY master)
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

    // Get reader (stdout from the PTY master) — clone master for resize later
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {e}"))?;

    let id = Uuid::new_v4().to_string();
    let id_clone = id.clone();
    let app_clone = app.clone();

    // Spawn background thread to read PTY output and emit events
    let ptys_clone = Arc::clone(&state.ptys);
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_clone.emit(&format!("pty-data-{}", id_clone), data);
                }
                Err(_) => break,
            }
        }
        // Collect exit code before emitting exit event
        let exit_code: Option<u32> = {
            let mut map = ptys_clone.lock();
            if let Some(pty) = map.get_mut(&id_clone) {
                pty.child.wait().ok().map(|status| status.exit_code())
            } else {
                None
            }
        };
        // Emit exit event with exit code payload (None if killed by signal/unknown)
        let _ = app_clone.emit(&format!("pty-exit-{}", id_clone), exit_code);
    });

    state.ptys.lock().insert(
        id.clone(),
        PtyInstance {
            writer,
            child,
            killer: pair.master,
        },
    );

    Ok(id)
}

#[tauri::command]
pub fn write_pty(state: tauri::State<PtyState>, id: String, data: String) -> Result<(), String> {
    let mut map = state.ptys.lock();
    let pty = map
        .get_mut(&id)
        .ok_or_else(|| format!("PTY '{id}' not found"))?;
    pty.writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Write failed: {e}"))
}

#[tauri::command]
pub fn resize_pty(
    state: tauri::State<PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.ptys.lock();
    let pty = map
        .get(&id)
        .ok_or_else(|| format!("PTY '{id}' not found"))?;
    pty.killer
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Resize failed: {e}"))
}

#[tauri::command]
pub fn kill_pty(state: tauri::State<PtyState>, id: String) -> Result<(), String> {
    let mut map = state.ptys.lock();
    if let Some(mut pty) = map.remove(&id) {
        pty.child.kill().map_err(|e| format!("Kill failed: {e}"))?;
    }
    Ok(())
}

/// Spawn a CLI process in stream-json mode.
///
/// Instead of forwarding raw PTY bytes, this command:
/// 1. Reads stdout line-by-line
/// 2. Parses each line as NDJSON
/// 3. Converts to a unified ChatMessage via the CLI-specific converter
/// 4. Emits `chat-message-{id}` Tauri events to the frontend
///
/// The `cli_kind` parameter selects the converter: "claude" or "codex".
/// Lines that fail JSON parsing are silently dropped (ANSI noise tolerance).
#[tauri::command]
pub fn spawn_stream_pty(
    app: AppHandle,
    state: tauri::State<PtyState>,
    command: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    cli_kind: String,
) -> Result<String, String> {
    let kind = match cli_kind.as_str() {
        "claude" => CliKind::ClaudeCode,
        "codex" => CliKind::Codex,
        other => {
            return Err(format!(
                "Unknown cli_kind: {other}. Expected 'claude' or 'codex'."
            ))
        }
    };

    let pty_system = NativePtySystem::default();

    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let mut cmd = if cfg!(windows) {
        let mut c = CommandBuilder::new("cmd.exe");
        c.arg("/C");
        c.arg(&command);
        for arg in &args {
            c.arg(arg);
        }
        c
    } else {
        let mut c = CommandBuilder::new(&command);
        for arg in &args {
            c.arg(arg);
        }
        c
    };

    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn '{command}': {e}"))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {e}"))?;

    let id = Uuid::new_v4().to_string();
    let id_clone = id.clone();
    let app_clone = app.clone();

    // Spawn background thread: line-buffered NDJSON parser
    let ptys_clone = Arc::clone(&state.ptys);
    std::thread::spawn(move || {
        let buf_reader = BufReader::new(reader);
        for line in buf_reader.lines() {
            match line {
                Ok(text) => {
                    if let Some(value) = stream_parser::parse_ndjson_line(&text) {
                        // Convert all blocks (handles multi-block messages)
                        let messages = stream_parser::convert_claude_all(&value);
                        if !messages.is_empty() && kind == CliKind::ClaudeCode {
                            for msg in messages {
                                let _ = app_clone.emit(&format!("chat-message-{}", id_clone), &msg);
                            }
                        } else if let Some(msg) = stream_parser::convert(kind, &value) {
                            let _ = app_clone.emit(&format!("chat-message-{}", id_clone), &msg);
                        }
                        // Also emit the raw JSON for debugging / advanced consumers
                        let _ = app_clone.emit(&format!("stream-raw-{}", id_clone), &value);
                    }
                    // Non-JSON lines are silently dropped (ANSI noise, etc.)
                }
                Err(_) => break,
            }
        }
        // Collect exit code
        let exit_code: Option<u32> = {
            let mut map = ptys_clone.lock();
            if let Some(pty) = map.get_mut(&id_clone) {
                pty.child.wait().ok().map(|status| status.exit_code())
            } else {
                None
            }
        };
        let _ = app_clone.emit(&format!("pty-exit-{}", id_clone), exit_code);
    });

    state.ptys.lock().insert(
        id.clone(),
        PtyInstance {
            writer,
            child,
            killer: pair.master,
        },
    );

    Ok(id)
}
