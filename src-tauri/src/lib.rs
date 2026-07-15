// The mailbox MCP server (and its register_agent/deregister_agent/
// get_mailbox_port commands) has been removed. It existed only so LM Studio
// could be handed a server_url via `integrations` — but LM Studio's
// ephemeral_mcp path rejects any private/loopback address (SSRF guard),
// which made a local Rust-hosted MCP server a dead end regardless of port
// choice. The app itself is now the MCP/tool-calling client: it talks to
// crw directly over HTTP and dispatches subagent-to-subagent "mailbox"
// messaging as a plain in-memory TypeScript module (see src/lib/mailbox-local.ts)
// rather than a separate server process. See mcp-client.ts, tool-loop.ts,
// and openai-compat.ts for the new flow.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_http::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
