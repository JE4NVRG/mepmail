// Release builds must not open a console window next to the app window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// `--mcp [--mailbox <id>]` turns the executable into a stdio MCP bridge for
/// an agent on this machine; anything else starts the app.
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--mcp") {
        let mailbox = value_after(&args, "--mailbox").unwrap_or_else(|| "default".to_string());
        let endpoint = std::env::var("MEPMAIL_CORREIO_MCP_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| mepmail_correio_lib::bridge::DEFAULT_ENDPOINT.to_string());
        let result = tauri::async_runtime::block_on(mepmail_correio_lib::bridge::run_stdio(
            mailbox, endpoint,
        ));
        if let Err(error) = result {
            eprintln!("mepmail-correio bridge: {error}");
            std::process::exit(2);
        }
        return;
    }
    mepmail_correio_lib::run()
}

fn value_after(args: &[String], flag: &str) -> Option<String> {
    let index = args.iter().position(|arg| arg == flag)?;
    args.get(index + 1).cloned()
}
