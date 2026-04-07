use parking_lot::Mutex;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde_json;
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

/// Pipe-based process instance (retained for write_pty compatibility).
#[allow(dead_code)]
struct PipeInstance {
    stdin: std::process::ChildStdin,
    child: std::process::Child,
}

#[allow(dead_code)]
enum ProcessInstance {
    Pty(PtyInstance),
    Pipe(PipeInstance),
}

type ProcessMap = Arc<Mutex<HashMap<String, ProcessInstance>>>;

#[derive(Clone)]
pub struct PtyState {
    procs: ProcessMap,
}

impl PtyState {
    pub fn new() -> Self {
        PtyState {
            procs: Arc::new(Mutex::new(HashMap::new())),
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
    let ptys_clone = Arc::clone(&state.procs);
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
            if let Some(ProcessInstance::Pty(pty)) = map.get_mut(&id_clone) {
                pty.child.wait().ok().map(|status| status.exit_code())
            } else {
                None
            }
        };
        // Emit exit event with exit code payload (None if killed by signal/unknown)
        let _ = app_clone.emit(&format!("pty-exit-{}", id_clone), exit_code);
    });

    state.procs.lock().insert(
        id.clone(),
        ProcessInstance::Pty(PtyInstance {
            writer,
            child,
            killer: pair.master,
        }),
    );

    Ok(id)
}

#[tauri::command]
pub fn write_pty(state: tauri::State<PtyState>, id: String, data: String) -> Result<(), String> {
    let mut map = state.procs.lock();
    let proc = map
        .get_mut(&id)
        .ok_or_else(|| format!("Process '{id}' not found"))?;
    match proc {
        ProcessInstance::Pty(pty) => pty.writer.write_all(data.as_bytes()),
        ProcessInstance::Pipe(pipe) => pipe.stdin.write_all(data.as_bytes()),
    }
    .map_err(|e| format!("Write failed: {e}"))
}

#[tauri::command]
pub fn resize_pty(
    state: tauri::State<PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.procs.lock();
    let proc = map
        .get(&id)
        .ok_or_else(|| format!("Process '{id}' not found"))?;
    match proc {
        ProcessInstance::Pty(pty) => pty.killer
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("Resize failed: {e}")),
        ProcessInstance::Pipe(_) => Ok(()), // resize is a no-op for pipe processes
    }
}

#[tauri::command]
pub fn kill_pty(state: tauri::State<PtyState>, id: String) -> Result<(), String> {
    let mut map = state.procs.lock();
    if let Some(proc) = map.remove(&id) {
        match proc {
            ProcessInstance::Pty(mut pty) => {
                pty.child.kill().map_err(|e| format!("Kill failed: {e}"))?;
            }
            ProcessInstance::Pipe(mut pipe) => {
                pipe.child.kill().map_err(|e| format!("Kill failed: {e}"))?;
            }
        }
    }
    Ok(())
}

/// Spawn a CLI process in stream-json mode using a real PTY.
///
/// Uses a PTY so the CLI detects a terminal and shows interactive prompts
/// (trust confirmation, channel development warning, etc.). The reader thread
/// operates in two phases:
///
/// **Phase 1 (Init):** Read raw PTY output byte-by-byte, accumulating into a
/// line buffer. Confirmation prompts from Ink UI are auto-accepted by sending
/// Enter (\r\n). Once a line starting with `{"type":"system"` is detected,
/// transition to Phase 2.
///
/// **Phase 2 (Stream):** Read line-by-line, strip ANSI escapes, parse NDJSON,
/// and emit `chat-message-{id}` Tauri events — same as the old pipe mode.
///
/// User input is sent as stream-json via `write_pty`.
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

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {e}"))?;

    let id = Uuid::new_v4().to_string();
    let id_clone = id.clone();
    let id_clone2 = id.clone();
    let app_clone = app.clone();

    // writer_for_init: we use the procs map to access the writer from the
    // background thread (take_writer can only be called once).

    state.procs.lock().insert(
        id.clone(),
        ProcessInstance::Pty(PtyInstance {
            writer,
            child,
            killer: pair.master,
        }),
    );

    // Spawn a helper thread that sends Enter keys periodically during init.
    // Ink UI confirmation prompts expect Enter to proceed. Since the prompts
    // use ANSI cursor control (no newlines), pattern matching is unreliable.
    // Instead, we send Enter every 2 seconds until the reader thread signals
    // that JSON output has started (init is complete).
    let init_done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let init_done_writer = Arc::clone(&init_done);
    let procs_for_enter = Arc::clone(&state.procs);
    let id_for_enter = id.clone();
    std::thread::spawn(move || {
        // Wait a moment for the CLI to start up
        std::thread::sleep(std::time::Duration::from_secs(2));
        // Send Enter periodically until init is done
        for _ in 0..15 {
            if init_done_writer.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            {
                let mut map = procs_for_enter.lock();
                if let Some(ProcessInstance::Pty(pty)) = map.get_mut(&id_for_enter) {
                    let _ = pty.writer.write_all(b"\r");
                    let _ = pty.writer.flush();
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    });

    // Spawn background thread: Phase 1 (init) → Phase 2 (stream)
    let procs_clone = Arc::clone(&state.procs);
    std::thread::spawn(move || {
        // ── Phase 1: Read PTY output until first JSON line ──
        // Ink UI uses ANSI cursor control, so output has no reliable newlines.
        // We read byte-by-byte and check for JSON start on every `\n` or `{`.
        let mut init_buf = Vec::with_capacity(8192);
        let mut byte = [0u8; 1];
        let mut json_start = None;

        'init: loop {
            match reader.read(&mut byte) {
                Ok(0) => break,
                Ok(1) => {
                    init_buf.push(byte[0]);

                    // On newline or when we see '{', check if we have JSON
                    if byte[0] == b'\n' || byte[0] == b'{' || init_buf.len() > 4096 {
                        let text = String::from_utf8_lossy(&init_buf);
                        let stripped = stream_parser::strip_ansi(&text);

                        // Scan for JSON object in the buffer
                        if let Some(json_pos) = stripped.find('{') {
                            let candidate = &stripped[json_pos..];
                            // Try to find a complete JSON object
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(candidate.trim()) {
                                json_start = Some(v);
                                break 'init;
                            }
                            // If candidate contains newline, try up to the first newline
                            if let Some(nl) = candidate.find('\n') {
                                let line = candidate[..nl].trim();
                                if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                                    json_start = Some(v);
                                    break 'init;
                                }
                            }
                        }

                        // Keep buffer manageable
                        if init_buf.len() > 4096 {
                            // Keep last 1024 bytes (might contain partial JSON)
                            let drain_to = init_buf.len() - 1024;
                            init_buf.drain(..drain_to);
                        }
                    }
                }
                _ => break,
            }
        }

        // Signal the Enter-sender thread to stop
        init_done.store(true, std::sync::atomic::Ordering::Relaxed);

        // Process the first JSON value if we found one
        if let Some(value) = &json_start {
            let messages = stream_parser::convert_claude_all(value);
            if !messages.is_empty() && kind == CliKind::ClaudeCode {
                for msg in messages {
                    let _ = app_clone.emit(&format!("chat-message-{}", id_clone), &msg);
                }
            } else if let Some(msg) = stream_parser::convert(kind, value) {
                let _ = app_clone.emit(&format!("chat-message-{}", id_clone), &msg);
            }
            let _ = app_clone.emit(&format!("stream-raw-{}", id_clone), value);
        }

        // ── Phase 2: Stream NDJSON ──
        // Wrap reader in BufReader for line-by-line reading.
        let buf_reader = BufReader::new(reader);
        for line in buf_reader.lines() {
            match line {
                Ok(text) => {
                    if let Some(value) = stream_parser::parse_ndjson_line(&text) {
                        let messages = stream_parser::convert_claude_all(&value);
                        if !messages.is_empty() && kind == CliKind::ClaudeCode {
                            for msg in messages {
                                let _ = app_clone.emit(&format!("chat-message-{}", id_clone), &msg);
                            }
                        } else if let Some(msg) = stream_parser::convert(kind, &value) {
                            let _ = app_clone.emit(&format!("chat-message-{}", id_clone), &msg);
                        }
                        let _ = app_clone.emit(&format!("stream-raw-{}", id_clone), &value);
                    }
                }
                Err(_) => break,
            }
        }

        // Collect exit code
        let exit_code: Option<u32> = {
            let mut map = procs_clone.lock();
            if let Some(ProcessInstance::Pty(pty)) = map.get_mut(&id_clone2) {
                pty.child.wait().ok().map(|status| status.exit_code())
            } else {
                None
            }
        };
        let _ = app_clone.emit(&format!("pty-exit-{}", id_clone2), exit_code);
    });

    Ok(id)
}
