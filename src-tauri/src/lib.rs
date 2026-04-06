mod chat_message;
mod config;
mod pty;
mod stream_parser;

use pty::PtyState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState::new())
        .invoke_handler(tauri::generate_handler![
            pty::spawn_pty,
            pty::spawn_stream_pty,
            pty::write_pty,
            pty::resize_pty,
            pty::kill_pty,
            config::load_config,
            config::save_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
