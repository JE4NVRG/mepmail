//! Commands the hosted Correio page may call to connect agents on this
//! machine: keep a mailbox's `mmb_` agent key in the credential vault and
//! write the agent's MCP configuration so it launches this executable as a
//! stdio bridge (`--mcp --mailbox <id>`). No key ever lands in a config file.
//!
//! The page's origin is trusted only so far: every write asks the user in a
//! native dialog first, every value is validated here, and CLI arguments are
//! passed as a list, so a script injected into the page cannot plant a config
//! or run an installer behind the user's back.

use std::{fs, path::PathBuf, process::Command};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::{bridge, is_portuguese};

const DEFAULT_SERVER_NAME: &str = "mepmail-correio";

#[derive(Serialize)]
pub struct InstallResult {
    pub ok: bool,
    pub target: String,
    /// The file written or the command output, for the page to show.
    pub detail: String,
}

/// A mailbox id is a UUID (8-4-4-4-12 hex digits).
fn valid_mailbox(value: &str) -> Result<(), String> {
    let groups: Vec<&str> = value.split('-').collect();
    let ok = groups.len() == 5
        && groups
            .iter()
            .zip([8usize, 4, 4, 4, 12])
            .all(|(group, len)| group.len() == len && group.bytes().all(|b| b.is_ascii_hexdigit()));
    if ok {
        Ok(())
    } else {
        Err("invalid_mailbox".to_string())
    }
}

/// An MCP server name as the agents' config files accept it.
fn valid_name(value: &str) -> Result<(), String> {
    let ok = !value.is_empty()
        && value.len() <= 40
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if ok {
        Ok(())
    } else {
        Err("invalid_name".to_string())
    }
}

/// The server's own agent-key shape: `mmb_` followed by up to 200 safe characters.
fn valid_token(value: &str) -> Result<(), String> {
    let rest = value.strip_prefix("mmb_").unwrap_or("");
    let ok = !rest.is_empty()
        && rest.len() <= 200
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'));
    if ok {
        Ok(())
    } else {
        Err("invalid_token".to_string())
    }
}

fn target_label(target: &str) -> Option<&'static str> {
    match target {
        "claude-desktop" => Some("Claude Desktop"),
        "cursor" => Some("Cursor"),
        "claude-code" => Some("Claude Code"),
        "codex" => Some("Codex"),
        _ => None,
    }
}

/// A native yes/no dialog the page cannot fake or dismiss. Blocking is fine
/// here: commands that call it are async, so they run off the main thread.
fn confirm<R: Runtime>(app: &AppHandle<R>, message: String) -> bool {
    let (title, allow, cancel) = if is_portuguese() {
        ("MepMail Correio", "Permitir", "Cancelar")
    } else {
        ("MepMail Correio", "Allow", "Cancel")
    };
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            allow.to_string(),
            cancel.to_string(),
        ))
        .blocking_show()
}

#[tauri::command]
pub async fn store_agent_key<R: Runtime>(
    app: AppHandle<R>,
    mailbox_id: String,
    token: String,
) -> Result<(), String> {
    valid_mailbox(&mailbox_id)?;
    let token = token.trim().to_string();
    valid_token(&token)?;
    let message = if is_portuguese() {
        format!(
            "A página do Correio quer guardar uma chave de agente neste computador, no Cofre do Windows, para a caixa {mailbox_id}. Agentes configurados aqui vão usá-la para ler e escrever nessa caixa.\n\nPermitir?"
        )
    } else {
        format!(
            "The Correio page wants to keep an agent key on this computer, in the Windows credential vault, for mailbox {mailbox_id}. Agents configured here will use it to read and write that mailbox.\n\nAllow?"
        )
    };
    if !confirm(&app, message) {
        return Err("cancelled".to_string());
    }
    bridge::key_entry(&mailbox_id)
        .and_then(|entry| entry.set_password(&token))
        .map_err(|error| format!("vault: {error}"))
}

#[tauri::command]
pub fn has_agent_key(mailbox_id: String) -> bool {
    valid_mailbox(&mailbox_id).is_ok()
        && bridge::key_entry(&mailbox_id)
            .and_then(|entry| entry.get_password())
            .is_ok()
}

#[tauri::command]
pub fn forget_agent_key(mailbox_id: String) -> Result<(), String> {
    valid_mailbox(&mailbox_id)?;
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

/// Runs an agent's own CLI (`claude mcp add …`, `codex mcp add …`) with the
/// arguments as a list. Every value in them was validated above (a UUID, a
/// `[a-z0-9-]` name, fixed flags and this executable's path), so the `.cmd`
/// shim npm installs on Windows receives nothing a shell could reinterpret.
fn run_cli(program: &str, args: &[String]) -> Result<String, String> {
    let output = if cfg!(windows) {
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
pub async fn install_agent<R: Runtime>(
    app: AppHandle<R>,
    target: String,
    mailbox_id: String,
    server_name: Option<String>,
) -> Result<InstallResult, String> {
    valid_mailbox(&mailbox_id)?;
    let name = server_name.unwrap_or_else(|| DEFAULT_SERVER_NAME.to_string());
    valid_name(&name)?;
    let label = target_label(&target).ok_or_else(|| "unknown_target".to_string())?;
    if !has_agent_key(mailbox_id.clone()) {
        return Err("no_key".to_string());
    }
    let command = bridge_command()?;
    let args = bridge_args(&mailbox_id);
    let what = match target.as_str() {
        "claude-desktop" | "cursor" => {
            if is_portuguese() {
                "gravar a entrada no arquivo de configuração dele"
            } else {
                "write the entry into its configuration file"
            }
        }
        _ => {
            if is_portuguese() {
                "executar o comando \"mcp add\" dele"
            } else {
                "run its \"mcp add\" command"
            }
        }
    };
    let message = if is_portuguese() {
        format!(
            "A página do Correio quer configurar o {label} para usar a caixa {mailbox_id} por este aplicativo (servidor MCP \"{name}\"). Isso vai {what}.\n\nPermitir?"
        )
    } else {
        format!(
            "The Correio page wants to configure {label} to use mailbox {mailbox_id} through this app (MCP server \"{name}\"). This will {what}.\n\nAllow?"
        )
    };
    if !confirm(&app, message) {
        return Err("cancelled".to_string());
    }
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
        "claude-code" | "codex" => {
            let mut cli = vec![
                "mcp".to_string(),
                "add".to_string(),
                name.clone(),
                "--".to_string(),
                command,
            ];
            cli.extend(args);
            run_cli(if target == "codex" { "codex" } else { "claude" }, &cli)?
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
        assert!(valid_mailbox("5d2c8d1e-7f1a-4b0e-9c3d-2a1b3c4d5e6f").is_ok());
        assert!(valid_mailbox("5D2C8D1E-7F1A-4B0E-9C3D-2A1B3C4D5E6F").is_ok());
        assert!(valid_mailbox("test-box").is_err());
        assert!(valid_mailbox("").is_err());
        assert!(valid_mailbox("../etc").is_err());
        assert!(valid_name("mepmail-correio").is_ok());
        assert!(valid_name("Mep Mail").is_err());
        assert!(valid_name("mep_mail").is_err());
        assert!(valid_token("mmb_5d2c8d1e.AbC-xyz_9").is_ok());
        assert!(valid_token("mmb_").is_err());
        assert!(valid_token("mmt_abc").is_err());
        assert!(valid_token("mmb_a b").is_err());
        assert!(target_label("codex").is_some());
        assert!(target_label("nowhere").is_none());
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
