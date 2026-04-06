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

/// Pipe-based process instance for stream-json mode (no PTY).
struct PipeInstance {
    stdin: std::process::ChildStdin,
    child: std::process::Child,
}

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

/// Spawn a CLI process in stream-json mode using stdin/stdout pipes (not PTY).
///
/// --print mode CLIs produce clean NDJSON on stdout when run without a PTY.
/// Using pipes instead of PTY avoids ANSI escape contamination and ensures
/// the CLI does not enter interactive terminal mode.
///
/// This command:
/// 1. Spawns the CLI with piped stdin/stdout
/// 2. Reads stdout line-by-line
/// 3. Parses each line as NDJSON
/// 4. Converts to a unified ChatMessage via the CLI-specific converter
/// 5. Emits `chat-message-{id}` Tauri events to the frontend
#[tauri::command]
pub fn spawn_stream_pty(
    app: AppHandle,
    state: tauri::State<PtyState>,
    command: String,
    args: Vec<String>,
    #[allow(unused_variables)] cols: u16,
    #[allow(unused_variables)] rows: u16,
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

    // Use std::process::Command with piped stdin/stdout instead of PTY.
    // This ensures the CLI runs in non-interactive mode with clean NDJSON output.
    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd.exe");
        c.arg("/C");
        c.arg(&command);
        for arg in &args {
            c.arg(arg);
        }
        c
    } else {
        let mut c = std::process::Command::new(&command);
        for arg in &args {
            c.arg(arg);
        }
        c
    };

    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    if let Some(dir) = &cwd {
        cmd.current_dir(dir);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn '{command}': {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to capture stdin".to_string())?;

    let id = Uuid::new_v4().to_string();
    let id_clone = id.clone();
    let id_clone2 = id.clone();
    let app_clone = app.clone();

    // Store pipe-based process
    state.procs.lock().insert(
        id.clone(),
        ProcessInstance::Pipe(PipeInstance { stdin, child }),
    );

    // Spawn background thread: line-buffered NDJSON parser
    let procs_clone = Arc::clone(&state.procs);
    std::thread::spawn(move || {
        let buf_reader = BufReader::new(stdout);
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
            if let Some(ProcessInstance::Pipe(pipe)) = map.get_mut(&id_clone2) {
                pipe.child.wait().ok().map(|s| s.code().unwrap_or(1) as u32)
            } else {
                None
            }
        };
        let _ = app_clone.emit(&format!("pty-exit-{}", id_clone2), exit_code);
    });

    Ok(id)
}
