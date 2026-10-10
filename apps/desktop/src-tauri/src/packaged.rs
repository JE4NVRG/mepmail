//! The Microsoft Store build (`--features store`): the same app inside an
//! MSIX package (apps/desktop/msix). A package changes four things, handled
//! here and by the `store` cfg gates elsewhere:
//!
//! - Updates come from the Store, so the self-updater is left out.
//! - Registry writes are virtualized, so "Start with Windows" is the
//!   package's StartupTask (declared in the manifest) instead of a Run key,
//!   and a launch by that task starts hidden, like `--minimized`.
//! - Toasts must carry the package's AppUserModelID (`<family>!App`): the
//!   notification plugin uses the bundle identifier, which a packaged app
//!   does not own, so the window's `Notification` is backed by
//!   `notify_native` instead.
//! - The executable lives in a versioned, protected folder; agent configs
//!   point at the package's execution alias instead (see `agents`).
//! - A package owns a taskbar badge Windows draws itself: the unread count
//!   goes there (`set_badge`) instead of into an overlay icon.

use tauri::{AppHandle, Runtime};
use windows::{
    core::HSTRING,
    ApplicationModel::{
        Activation::ActivationKind, AppInstance, Package, StartupTask, StartupTaskState,
    },
    Data::Xml::Dom::XmlDocument,
    UI::Notifications::{BadgeNotification, BadgeUpdateManager},
};

/// `TaskId` of the StartupTask in AppxManifest.xml.
const STARTUP_TASK: &str = "MepMailCorreioStartup";
/// `Id` of the Application element in AppxManifest.xml.
const APPLICATION_ID: &str = "App";

/// Whether this process runs with package identity (installed from the
/// MSIX), as opposed to a store-flavoured exe started by hand.
pub fn has_identity() -> bool {
    Package::Current().is_ok()
}

/// The package's AppUserModelID, the sender name toasts must use.
fn app_user_model_id() -> Option<String> {
    let family = Package::Current().ok()?.Id().ok()?.FamilyName().ok()?;
    Some(format!("{family}!{APPLICATION_ID}"))
}

/// Shows `unread` on the package's taskbar badge (Windows caps it at "99+")
/// or clears it at 0. Fails without package identity, so the caller can fall
/// back to the overlay icon.
pub fn set_badge(unread: u32) -> windows::core::Result<()> {
    if !has_identity() {
        return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
            0x80070490_u32 as i32,
        )));
    }
    let updater = BadgeUpdateManager::CreateBadgeUpdaterForApplication()?;
    if unread == 0 {
        return updater.Clear();
    }
    let xml = XmlDocument::new()?;
    xml.LoadXml(&HSTRING::from(format!("<badge value=\"{unread}\"/>")))?;
    updater.Update(&BadgeNotification::CreateBadgeNotification(&xml)?)
}

/// Started by the StartupTask at sign-in: stay in the tray.
pub fn launched_at_startup() -> bool {
    if !has_identity() {
        return false;
    }
    AppInstance::GetActivatedEventArgs()
        .and_then(|args| args.Kind())
        .map(|kind| kind == ActivationKind::StartupTask)
        .unwrap_or(false)
}

fn startup_task() -> windows::core::Result<StartupTask> {
    StartupTask::GetAsync(&HSTRING::from(STARTUP_TASK))?.join()
}

/// Whether the app starts with Windows.
pub fn startup_enabled() -> bool {
    startup_task()
        .and_then(|task| task.State())
        .map(|state| {
            state == StartupTaskState::Enabled || state == StartupTaskState::EnabledByPolicy
        })
        .unwrap_or(false)
}

/// Turns starting with Windows on or off. Windows keeps the last word: a
/// task the user disabled in Settings stays off until they enable it there.
pub fn set_startup(enabled: bool) -> Result<bool, String> {
    let task = startup_task().map_err(|error| error.to_string())?;
    if enabled {
        let state = task
            .RequestEnableAsync()
            .and_then(|operation| operation.join())
            .map_err(|error| error.to_string())?;
        Ok(state == StartupTaskState::Enabled || state == StartupTaskState::EnabledByPolicy)
    } else {
        task.Disable().map_err(|error| error.to_string())?;
        Ok(false)
    }
}

/// A native toast sent as the package. The hosted page reaches it through
/// the `Notification` shim in `notification_shim`.
#[tauri::command]
pub async fn notify_native<R: Runtime>(
    _app: AppHandle<R>,
    title: String,
    body: Option<String>,
) -> Result<(), String> {
    let title: String = title.chars().take(200).collect();
    let body: String = body.unwrap_or_default().chars().take(1000).collect();
    let Some(app_id) = app_user_model_id() else {
        return Err("no_package_identity".to_string());
    };
    tauri::async_runtime::spawn_blocking(move || {
        tauri_winrt_notification::Toast::new(&app_id)
            .title(&title)
            .text1(&body)
            .show()
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Replaces `window.Notification` in every document the window loads with
/// a minimal implementation backed by `notify_native`: permission is always
/// granted (the app is the user's own mail client), `close()` is a no-op.
pub fn notification_shim() -> &'static str {
    r#"(() => {
  const invoke = (command, args) => window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke(command, args);
  class MepMailNotification extends EventTarget {
    static get permission() { return "granted"; }
    static requestPermission(callback) {
      if (typeof callback === "function") callback("granted");
      return Promise.resolve("granted");
    }
    constructor(title, options = {}) {
      super();
      this.title = String(title);
      this.body = options.body == null ? "" : String(options.body);
      this.tag = options.tag == null ? "" : String(options.tag);
      this.onclick = null; this.onshow = null; this.onerror = null; this.onclose = null;
      Promise.resolve(invoke("notify_native", { title: this.title, body: this.body }))
        .then(() => { const event = new Event("show"); this.dispatchEvent(event); if (this.onshow) this.onshow(event); })
        .catch(() => { const event = new Event("error"); this.dispatchEvent(event); if (this.onerror) this.onerror(event); });
    }
    close() {}
  }
  Object.defineProperty(window, "Notification", { value: MepMailNotification, writable: false, configurable: false });
})();"#
}
