//! Automatic updates of the native shell. Most of Correio lives on mepmail.dev
//! and updates with every web release; this covers the shell itself (tray,
//! badge, agents bridge, deep links).
//!
//! The shell reads the endpoint in `plugins.updater` (tauri.conf.json,
//! https://mepmail.dev/desktop/correio/latest.json) 20 s after it starts and
//! every six hours. A newer version is downloaded in the background and its
//! minisign signature checked against the public key in the config. It is
//! never installed under someone's hands: a dialog popping up while they
//! type could be accepted by a stray Enter, and the restart would drop an
//! unsaved draft. So a ready update installs
//!
//! - right away when the app started hidden in the tray (the autostart entry
//!   at sign-in) and its window has not been opened yet: nothing is in use,
//!   and the new version starts hidden again;
//! - when the app quits (tray "Quit", or closing the window without
//!   keep-in-tray), without starting it again;
//! - when the user picks "Restart to update" in the tray.
//!
//! Visible windows get one notification and the tray item instead.
//! "Check for updates" (tray) asks in a dialog, right after the click.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};

use tauri::{AppHandle, Manager, Runtime, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{is_portuguese, tray, StartHidden, MAIN_WINDOW};

/// Long enough for the window and the hosted app to settle first.
const FIRST_CHECK: Duration = Duration::from_secs(20);
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Release notes longer than this are cut in the dialog.
const NOTES_LIMIT: usize = 400;

/// A downloaded, signature-checked update waiting for a safe moment.
struct Ready {
    update: Update,
    bytes: Vec<u8>,
}

#[derive(Default)]
pub struct UpdateState {
    /// One check, download or install at a time.
    busy: AtomicBool,
    ready: Mutex<Option<Ready>>,
    /// The window has had focus since the app started: someone may be using it.
    used: AtomicBool,
    /// The version the notification already announced.
    announced: Mutex<Option<String>>,
}

impl UpdateState {
    fn ready_version(&self) -> Option<String> {
        self.ready
            .lock()
            .ok()
            .and_then(|ready| ready.as_ref().map(|ready| ready.update.version.clone()))
    }
}

/// Appends a line to `updates.log` in the app's log directory
/// (%LOCALAPPDATA%\dev.mepmail.correio\logs): the release build has no
/// console, and "why did it not update" needs an answer on the user's PC.
/// The file is cut back to empty past 256 KB.
fn note<R: Runtime>(handle: &AppHandle<R>, message: &str) {
    use std::io::Write;
    let Ok(dir) = handle.path().app_log_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("updates.log");
    let too_big = std::fs::metadata(&path)
        .map(|meta| meta.len() > 256 * 1024)
        .unwrap_or(false);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(!too_big)
        .write(true)
        .truncate(too_big)
        .open(&path);
    if let Ok(mut file) = file {
        let seconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or(0);
        let version = handle.package_info().version.to_string();
        let _ = writeln!(file, "{seconds} v{version} {message}");
    }
}

/// Releases the busy flag however the work ends.
struct Busy<'a>(&'a AtomicBool);

impl Busy<'_> {
    fn take(flag: &AtomicBool) -> Option<Busy<'_>> {
        (!flag.swap(true, Ordering::SeqCst)).then_some(Busy(flag))
    }
}

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn pt() -> bool {
    is_portuguese()
}

/// The tray item label: "Check for updates", or "Restart to update (x.y.z)"
/// once a version is downloaded.
pub fn tray_label(ready: Option<&str>) -> String {
    match (ready, pt()) {
        (Some(version), true) => format!("Reiniciar para atualizar ({version})"),
        (Some(version), false) => format!("Restart to update ({version})"),
        (None, true) => "Procurar atualizações".to_string(),
        (None, false) => "Check for updates".to_string(),
    }
}

/// The release notes as a dialog paragraph: blank lines first, cut to
/// NOTES_LIMIT characters; nothing when the release has no notes.
fn notes_paragraph(body: Option<&str>) -> String {
    body.map(str::trim)
        .filter(|notes| !notes.is_empty())
        .map(|notes| {
            let mut cut: String = notes.chars().take(NOTES_LIMIT).collect();
            if notes.chars().count() > NOTES_LIMIT {
                cut.push('…');
            }
            format!("\n\n{cut}")
        })
        .unwrap_or_default()
}

fn offer_text(update: &Update) -> String {
    let notes = notes_paragraph(update.body.as_deref());
    if pt() {
        format!(
            "A versão {} do MepMail está disponível (você tem a {}).{notes}\n\nAtualizar agora fecha o MepMail e abre de novo em alguns segundos. Depois: ela instala quando você sair do MepMail.",
            update.version, update.current_version
        )
    } else {
        format!(
            "MepMail {} is available (you have {}).{notes}\n\nUpdate now closes MepMail and opens it again in a few seconds. Later: it installs when you quit MepMail.",
            update.version, update.current_version
        )
    }
}

fn up_to_date_text(version: &str) -> String {
    if pt() {
        format!("Você já tem a versão mais recente do MepMail ({version}).")
    } else {
        format!("You have the latest MepMail ({version}).")
    }
}

fn check_failed_text(error: &str) -> String {
    if pt() {
        format!(
            "Não foi possível procurar atualizações agora. Tente de novo mais tarde.\n\n{error}"
        )
    } else {
        format!("Could not check for updates right now. Try again later.\n\n{error}")
    }
}

fn install_failed_text(error: &str) -> String {
    if pt() {
        format!(
            "A atualização não pôde ser instalada. O MepMail continua na versão atual.\n\n{error}"
        )
    } else {
        format!(
            "The update could not be installed. MepMail stays on the current version.\n\n{error}"
        )
    }
}

fn ready_notice(version: &str) -> (String, String) {
    if pt() {
        (
            format!("MepMail {version} está pronto"),
            "A atualização instala quando você sair do MepMail. Para instalar agora: ícone na bandeja, Reiniciar para atualizar.".to_string(),
        )
    } else {
        (
            format!("MepMail {version} is ready"),
            "The update installs when you quit MepMail. To install now: tray icon, Restart to update.".to_string(),
        )
    }
}

fn ready_tooltip(version: &str) -> String {
    if pt() {
        format!("MepMail: versão {version} pronta para instalar")
    } else {
        format!("MepMail: version {version} ready to install")
    }
}

/// A native dialog over the main window when it is on screen. `None` for the
/// cancel label shows a single OK button. Resolves to whether OK was chosen;
/// closing the dialog or Escape count as cancel.
async fn ask<R: Runtime>(
    handle: &AppHandle<R>,
    message: String,
    kind: MessageDialogKind,
    ok: &str,
    cancel: Option<&str>,
) -> bool {
    let buttons = match cancel {
        Some(cancel) => MessageDialogButtons::OkCancelCustom(ok.to_string(), cancel.to_string()),
        None => MessageDialogButtons::OkCustom(ok.to_string()),
    };
    let mut dialog = handle
        .dialog()
        .message(message)
        .title("MepMail")
        .kind(kind)
        .buttons(buttons);
    if let Some(window) = handle.get_webview_window(MAIN_WINDOW) {
        if window.is_visible().unwrap_or(false) {
            dialog = dialog.parent(&window);
        }
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    dialog.show(move |accepted| {
        let _ = sender.send(accepted);
    });
    receiver.await.unwrap_or(false)
}

async fn tell<R: Runtime>(handle: &AppHandle<R>, message: String, kind: MessageDialogKind) {
    ask(handle, message, kind, "OK", None).await;
}

async fn find<R: Runtime>(handle: &AppHandle<R>) -> Result<Option<Update>, String> {
    handle
        .updater_builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())
}

/// Started hidden and never opened since: nobody is using the window.
fn idle_in_tray<R: Runtime>(handle: &AppHandle<R>, state: &UpdateState) -> bool {
    let started_hidden = handle
        .try_state::<StartHidden>()
        .map(|value| value.0)
        .unwrap_or(false);
    let visible = handle
        .get_webview_window(MAIN_WINDOW)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    let used = state.used.load(Ordering::SeqCst);
    note(
        handle,
        &format!("idle check: started_hidden={started_hidden} visible={visible} used={used}"),
    );
    started_hidden && !visible && !used
}

/// Runs the installer from memory. On success this does not return: the
/// installer replaces the app and the process exits (and, with `restart`,
/// the installer starts the new version with this run's arguments, so an
/// app started with `--minimized` comes back hidden).
fn install(ready: Ready, restart: bool) -> Result<(), String> {
    ready
        .update
        .restart_after_install(restart)
        .install(&ready.bytes)
        .map_err(|error| error.to_string())
}

fn mark_ready<R: Runtime>(handle: &AppHandle<R>, state: &UpdateState, version: &str) {
    tray::set_updates_label(handle, &tray_label(Some(version)));
    tray::set_tooltip(handle, &ready_tooltip(version));
    let first = state
        .announced
        .lock()
        .map(|mut announced| {
            let first = announced.as_deref() != Some(version);
            *announced = Some(version.to_string());
            first
        })
        .unwrap_or(false);
    if first {
        let (title, body) = ready_notice(version);
        if let Err(error) = handle
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
        {
            note(handle, &format!("update notice: {error}"));
        }
    }
}

/// The background check: find, download, then install only if nobody is
/// using the app; otherwise announce it once.
async fn background<R: Runtime>(handle: AppHandle<R>) {
    let Some(state) = handle.try_state::<UpdateState>() else {
        return;
    };
    let Some(_busy) = Busy::take(&state.busy) else {
        return;
    };
    let update = match find(&handle).await {
        Ok(Some(update)) => update,
        Ok(None) => return,
        Err(error) => {
            note(&handle, &format!("update check failed: {error}"));
            return;
        }
    };
    note(&handle, &format!("found {}", update.version));
    if state.ready_version().as_deref() != Some(update.version.as_str()) {
        match update.download(|_, _| {}, || {}).await {
            Ok(bytes) => {
                note(
                    &handle,
                    &format!("downloaded {} bytes, signature ok", bytes.len()),
                );
                if let Ok(mut ready) = state.ready.lock() {
                    *ready = Some(Ready { update, bytes });
                }
            }
            Err(error) => {
                note(&handle, &format!("update download failed: {error}"));
                return;
            }
        }
    }
    if idle_in_tray(&handle, &state) {
        if let Some(ready) = state.ready.lock().ok().and_then(|mut ready| ready.take()) {
            note(&handle, "installing while idle in the tray");
            if let Err(error) = install(ready, true) {
                note(&handle, &format!("update install failed: {error}"));
            }
            return;
        }
    }
    if let Some(version) = state.ready_version() {
        mark_ready(&handle, &state, &version);
    }
}

/// The tray item: installs a downloaded update now, or checks and asks.
async fn from_tray<R: Runtime>(handle: AppHandle<R>) {
    let Some(state) = handle.try_state::<UpdateState>() else {
        return;
    };
    let Some(_busy) = Busy::take(&state.busy) else {
        return;
    };
    if let Some(ready) = state.ready.lock().ok().and_then(|mut ready| ready.take()) {
        if let Err(error) = install(ready, true) {
            note(&handle, &format!("update install failed: {error}"));
            tray::set_updates_label(&handle, &tray_label(None));
            tray::set_tooltip(&handle, "MepMail");
            tell(
                &handle,
                install_failed_text(&error),
                MessageDialogKind::Warning,
            )
            .await;
        }
        return;
    }
    let update = match find(&handle).await {
        Ok(Some(update)) => update,
        Ok(None) => {
            let version = handle.package_info().version.to_string();
            tell(&handle, up_to_date_text(&version), MessageDialogKind::Info).await;
            return;
        }
        Err(error) => {
            note(&handle, &format!("update check failed: {error}"));
            tell(
                &handle,
                check_failed_text(&error),
                MessageDialogKind::Warning,
            )
            .await;
            return;
        }
    };
    let (update_now, later) = if pt() {
        ("Atualizar agora", "Depois")
    } else {
        ("Update now", "Later")
    };
    let accepted = ask(
        &handle,
        offer_text(&update),
        MessageDialogKind::Info,
        update_now,
        Some(later),
    )
    .await;
    let version = update.version.clone();
    let bytes = match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => bytes,
        Err(error) => {
            note(&handle, &format!("update download failed: {error}"));
            tell(
                &handle,
                install_failed_text(&error.to_string()),
                MessageDialogKind::Warning,
            )
            .await;
            return;
        }
    };
    let ready = Ready { update, bytes };
    if accepted {
        if let Err(error) = install(ready, true) {
            note(&handle, &format!("update install failed: {error}"));
            tell(
                &handle,
                install_failed_text(&error),
                MessageDialogKind::Warning,
            )
            .await;
        }
        return;
    }
    if let Ok(mut slot) = state.ready.lock() {
        *slot = Some(ready);
    }
    // They have just read about it: the tray item is enough, no notice.
    if let Ok(mut announced) = state.announced.lock() {
        *announced = Some(version.clone());
    }
    mark_ready(&handle, &state, &version);
}

/// The tray item ("Check for updates" / "Restart to update").
pub fn tray_clicked<R: Runtime>(handle: &AppHandle<R>) {
    tauri::async_runtime::spawn(from_tray(handle.clone()));
}

/// The app is exiting: a downloaded update installs now, without reopening.
pub fn on_exit<R: Runtime>(handle: &AppHandle<R>) {
    let Some(state) = handle.try_state::<UpdateState>() else {
        return;
    };
    if state.busy.load(Ordering::SeqCst) {
        return;
    }
    if let Some(ready) = state.ready.lock().ok().and_then(|mut ready| ready.take()) {
        note(handle, "installing on exit");
        if let Err(error) = install(ready, false) {
            note(handle, &format!("update install on exit failed: {error}"));
        }
    }
}

/// Starts the background checks. Called once from setup, after the window.
pub fn start<R: Runtime>(handle: AppHandle<R>) {
    handle.manage(UpdateState::default());
    if let Some(window) = handle.get_webview_window(MAIN_WINDOW) {
        let focus_handle = handle.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::Focused(true) = event {
                // WebView2 focuses the hidden window while it starts: only a
                // window on screen counts as someone using it.
                let visible = focus_handle
                    .get_webview_window(MAIN_WINDOW)
                    .and_then(|window| window.is_visible().ok())
                    .unwrap_or(false);
                if !visible {
                    return;
                }
                if let Some(state) = focus_handle.try_state::<UpdateState>() {
                    if !state.used.swap(true, Ordering::SeqCst) {
                        note(
                            &focus_handle,
                            "window focused: updates wait for a safe moment",
                        );
                    }
                }
            }
        });
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            background(handle.clone()).await;
            tokio::time::sleep(EVERY).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_notes_are_trimmed_and_bounded() {
        assert_eq!(notes_paragraph(None), "");
        assert_eq!(notes_paragraph(Some("  \n ")), "");
        assert_eq!(
            notes_paragraph(Some(" Busca mais rápida. ")),
            "\n\nBusca mais rápida."
        );
        let long = "á".repeat(NOTES_LIMIT + 10);
        let paragraph = notes_paragraph(Some(&long));
        assert_eq!(paragraph.chars().count(), NOTES_LIMIT + 3);
        assert!(paragraph.ends_with('…'));
    }

    #[test]
    fn the_tray_item_names_the_ready_version() {
        let ready = tray_label(Some("0.3.1"));
        assert!(ready.contains("0.3.1"));
        assert_ne!(ready, tray_label(None));
    }
}
