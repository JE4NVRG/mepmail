//! Commands the hosted Correio page may call to connect agents on this
//! machine: keep a mailbox's `mmb_` agent key in the credential vault and
//! write the agent's MCP configuration so it launches this executable as a
//! stdio bridge (`--mcp --mailbox <id>`). No key ever lands in a config file.

use std::{fs, path::PathBuf, process::Command};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::bridge;

const DEFAULT_SERVER_NAME: &str = "mepmail-correio";

#[derive(Serialize)]
pub struct InstallResult {
    pub ok: bool,
    pub target: String,
    /// The file written or the command output, for the page to show.
    pub detail: String,
}

fn valid_id(value: &str) -> Result<(), String> {
    let ok = !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if ok {
        Ok(())
    } else {
        Err("invalid_mailbox".to_string())
    }
}

fn valid_name(value: &str) -> Result<(), String> {
    let ok = !value.is_empty()
        && value.len() <= 40
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_');
    if ok {
        Ok(())
    } else {
        Err("invalid_name".to_string())
    }
}

#[tauri::command]
pub fn store_agent_key(mailbox_id: String, token: String) -> Result<(), String> {
    valid_id(&mailbox_id)?;
    let token = token.trim();
    if !token.starts_with("mmb_") || token.len() > 220 || !token.is_ascii() {
        return Err("invalid_token".to_string());
    }
    bridge::key_entry(&mailbox_id)
        .and_then(|entry| entry.set_password(token))
        .map_err(|error| format!("vault: {error}"))
}

#[tauri::command]
pub fn has_agent_key(mailbox_id: String) -> bool {
    valid_id(&mailbox_id).is_ok()
        && bridge::key_entry(&mailbox_id)
            .and_then(|entry| entry.get_password())
            .is_ok()
}

#[tauri::command]
pub fn forget_agent_key(mailbox_id: String) -> Result<(), String> {
    valid_id(&mailbox_id)?;
    match bridge::key_entry(&mailbox_id).and_then(|entry| entry.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("vault: {error}")),
    }
}

/// Where this executable is, as the agent config must launch it.
fn bridge_command() -> Result<String, String> {
    std::env::current_exe()
        .map_err(|error| error.to_string())
        .and_then(|path| {
            path.to_str()
                .map(str::to_string)
                .ok_or("exe_path".to_string())
        })
}

fn bridge_args(mailbox_id: &str) -> Vec<String> {
    vec![
        "--mcp".to_string(),
        "--mailbox".to_string(),
        mailbox_id.to_string(),
    ]
}

fn env_dir(name: &str) -> Result<PathBuf, String> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .ok_or_else(|| format!("missing_{}", name.to_lowercase()))
}

/// Merges `mcpServers[name]` into a JSON config file, creating it if needed.
fn write_json_server(
    path: PathBuf,
    name: &str,
    command: &str,
    args: &[String],
) -> Result<String, String> {
    let mut root: Value = match fs::read(&path) {
        Ok(bytes) if !bytes.is_empty() => serde_json::from_slice(&bytes)
            .map_err(|error| format!("{}: {error}", path.display()))?,
        _ => Value::Object(Map::new()),
    };
    let object = root
        .as_object_mut()
        .ok_or_else(|| format!("{} is not a JSON object", path.display()))?;
    let servers = object
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()));
    let servers = servers
        .as_object_mut()
        .ok_or_else(|| format!("{}: mcpServers is not an object", path.display()))?;
    servers.insert(
        name.to_string(),
        json!({ "command": command, "args": args }),
    );
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(&root).map_err(|error| error.to_string())?;
    fs::write(&path, format!("{text}\n"))
        .map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(path.display().to_string())
}

/// Runs an agent's own CLI (`claude mcp add …`, `codex mcp add …`).
fn run_cli(program: &str, args: &[String]) -> Result<String, String> {
    let output = if cfg!(windows) {
        // npm and pip shims are .cmd files; cmd resolves them through PATH.
        let mut command = Command::new("cmd");
        command.arg("/c").arg(program).args(args);
        command.output()
    } else {
        Command::new(program).args(args).output()
    };
    let output = output.map_err(|error| format!("{program}: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = format!("{}{}", stdout.trim(), stderr.trim());
    if output.status.success() {
        Ok(text.chars().take(400).collect())
    } else if text.contains("not recognized") || text.contains("not found") {
        Err("not_installed".to_string())
    } else {
        Err(text.chars().take(400).collect())
    }
}

#[tauri::command]
pub fn install_agent(
    target: String,
    mailbox_id: String,
    server_name: Option<String>,
) -> Result<InstallResult, String> {
    valid_id(&mailbox_id)?;
    let name = server_name.unwrap_or_else(|| DEFAULT_SERVER_NAME.to_string());
    valid_name(&name)?;
    if !has_agent_key(mailbox_id.clone()) {
        return Err("no_key".to_string());
    }
    let command = bridge_command()?;
    let args = bridge_args(&mailbox_id);
    let detail = match target.as_str() {
        "claude-desktop" => write_json_server(
            env_dir("APPDATA")?
                .join("Claude")
                .join("claude_desktop_config.json"),
            &name,
            &command,
            &args,
        )?,
        "cursor" => write_json_server(
            env_dir("USERPROFILE")?.join(".cursor").join("mcp.json"),
            &name,
            &command,
            &args,
        )?,
        "claude-code" => {
            let mut cli = vec![
                "mcp".to_string(),
                "add".to_string(),
                name.clone(),
                "--".to_string(),
                command,
            ];
            cli.extend(args);
            run_cli("claude", &cli)?
        }
        "codex" => {
            let mut cli = vec![
                "mcp".to_string(),
                "add".to_string(),
                name.clone(),
                "--".to_string(),
                command,
            ];
            cli.extend(args);
            run_cli("codex", &cli)?
        }
        _ => return Err("unknown_target".to_string()),
    };
    Ok(InstallResult {
        ok: true,
        target,
        detail,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_identifiers() {
        assert!(valid_id("5d2c8d1e-7f1a-4b0e-9c3d-2a1b3c4d5e6f").is_ok());
        assert!(valid_id("").is_err());
        assert!(valid_id("../etc").is_err());
        assert!(valid_name("mepmail-correio").is_ok());
        assert!(valid_name("Mep Mail").is_err());
    }

    #[test]
    fn writes_the_server_entry_without_touching_the_rest() {
        let dir = std::env::temp_dir().join(format!("mepmail-agents-test-{}", std::process::id()));
        let path = dir.join("claude_desktop_config.json");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            &path,
            r#"{"theme":"dark","mcpServers":{"other":{"command":"x"}}}"#,
        )
        .unwrap();
        let args = bridge_args("abc");
        write_json_server(path.clone(), "mepmail-correio", "C:\\app.exe", &args).unwrap();
        let root: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(root["theme"], "dark");
        assert_eq!(root["mcpServers"]["other"]["command"], "x");
        assert_eq!(
            root["mcpServers"]["mepmail-correio"]["command"],
            "C:\\app.exe"
        );
        assert_eq!(root["mcpServers"]["mepmail-correio"]["args"][2], "abc");
        let _ = fs::remove_dir_all(&dir);
    }
}
