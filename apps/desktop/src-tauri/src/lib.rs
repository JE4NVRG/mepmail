//! MepMail Correio for the desktop.
//!
//! Version 0.1 is a native shell around the hosted Correio app. The window
//! opens on a bundled splash page (`src/index.html`) that checks mepmail.dev
//! answers and then loads <https://mepmail.dev/mail>. The shell adds what a
//! browser tab cannot: a single instance, a tray icon, remembered window
//! placement, links outside MepMail opened in the system browser, and a
//! `window.__MEPMAIL_DESKTOP__` marker the web app can read.

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::{Color, NewWindowResponse, PageLoadEvent},
    AppHandle, Manager, Runtime, Theme, Url, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;

/// The hosted Correio app the shell hands the window to.
pub const CORREIO_URL: &str = "https://mepmail.dev/mail";

/// Label of the only window. The capability file and the tray refer to it.
pub const MAIN_WINDOW: &str = "main";

/// Hosts the webview may navigate to by itself. Every other http(s)
/// destination opens in the system browser: Stripe Checkout, the docs,
/// links inside emails.
const IN_APP_HOSTS: &[&str] = &["mepmail.dev", "www.mepmail.dev"];

/// Sign-in with Google redirects through Google and back. Those pages must
/// stay in the webview, or the session cookie would land in another browser.
/// An explicit list, never a `.google.com` suffix: a Docs or Meet link inside
/// an email must open in the browser, not replace the inbox.
const SIGN_IN_HOSTS: &[&str] = &[
    "accounts.google.com",
    "accounts.youtube.com",
    "myaccount.google.com",
];

fn is_in_app_host(host: &str) -> bool {
    IN_APP_HOSTS.contains(&host)
}

fn is_sign_in_host(host: &str) -> bool {
    SIGN_IN_HOSTS.contains(&host)
}

/// Whether the main webview may navigate to `url` itself (a link, a redirect,
/// a form post). Sign-in hosts are allowed here only, for the redirect chain.
pub fn navigation_allowed(url: &Url) -> bool {
    match url.scheme() {
        // The bundled splash page (tauri://localhost, or http://tauri.localhost
        // on Windows) and blank documents.
        "tauri" | "about" => true,
        "http" | "https" => match url.host_str() {
            Some(host) => {
                host == "tauri.localhost"
                    || (cfg!(debug_assertions) && (host == "localhost" || host == "127.0.0.1"))
                    || is_in_app_host(host)
                    || is_sign_in_host(host)
            }
            None => false,
        },
        _ => false,
    }
}

/// Whether a new-window request (`target="_blank"`, `window.open`) should
/// load in the main window instead: only MepMail's own pages. A sign-in host,
/// a blob or anything else never replaces the inbox through this path.
pub fn opens_in_main(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && url.host_str().is_some_and(is_in_app_host)
}

/// Whether a link the webview refused may be handed to the operating system.
/// Web links, mail links and the one editor deep link the dashboard itself
/// opens (`cursor://`, "Open in Cursor" on the domain page). Email bodies are
/// sanitized to http, https and mailto, so no other scheme can come from mail.
fn opens_outside(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto" | "cursor")
}

/// Opens `url` in the default browser (or mail client), off the webview
/// callback that asked for it.
fn open_outside<R: Runtime>(handle: &AppHandle<R>, url: Url) {
    if !opens_outside(&url) {
        eprintln!("mepmail-correio: refused to open {url}");
        return;
    }
    let handle = handle.clone();
    let _ = tauri::async_runtime::spawn(async move {
        if let Err(error) = handle.opener().open_url(url.as_str(), None::<&str>) {
            eprintln!("mepmail-correio: could not open {url} outside: {error}");
        }
    });
}

/// Loads `url` in the main window, off the webview callback that asked for it.
fn navigate_main<R: Runtime>(handle: &AppHandle<R>, url: Url) {
    let handle = handle.clone();
    let _ = tauri::async_runtime::spawn(async move {
        if let Some(window) = handle.get_webview_window(MAIN_WINDOW) {
            if let Err(error) = window.navigate(url) {
                eprintln!("mepmail-correio: could not navigate the main window: {error}");
            }
        }
    });
}

/// Brings the main window to the front (tray click, second launch).
fn show_main<R: Runtime>(handle: &AppHandle<R>) {
    if let Some(window) = handle.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Script injected before every document the webview loads, the hosted app
/// included. It marks the page as running inside the desktop shell so the
/// web app can adapt (hide "back to the dashboard", send native
/// notifications) without sniffing the user agent.
fn bridge_script() -> String {
    format!(
        r#"(() => {{
  const info = Object.freeze({{ app: "mepmail-correio", version: "{version}", platform: "{platform}" }});
  Object.defineProperty(window, "__MEPMAIL_DESKTOP__", {{ value: info, writable: false, configurable: false }});
  const mark = () => {{
    const html = document.documentElement;
    if (html && html.dataset.mepmailDesktop !== info.version) html.dataset.mepmailDesktop = info.version;
  }};
  // The attribute is applied as soon as <html> exists and re-applied if the
  // page's own rendering drops it (hydration may rewrite root attributes).
  const watch = () => {{
    mark();
    if (!document.documentElement) return;
    new MutationObserver(mark).observe(document.documentElement, {{
      attributes: true,
      attributeFilter: ["data-mepmail-desktop"],
    }});
  }};
  if (document.readyState === "loading") {{
    document.addEventListener("DOMContentLoaded", watch, {{ once: true }});
  }} else {{
    watch();
  }}
  window.addEventListener("load", mark, {{ once: true }});
}})();"#,
        version = env!("CARGO_PKG_VERSION"),
        platform = std::env::consts::OS,
    )
}

struct TrayStrings {
    open: &'static str,
    quit: &'static str,
}

fn tray_strings() -> TrayStrings {
    let portuguese = sys_locale::get_locale()
        .map(|locale| locale.to_ascii_lowercase().starts_with("pt"))
        .unwrap_or(false);
    if portuguese {
        TrayStrings {
            open: "Abrir Correio",
            quit: "Sair",
        }
    } else {
        TrayStrings {
            open: "Open Correio",
            quit: "Quit",
        }
    }
}

fn build_tray<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let strings = tray_strings();
    let open = MenuItem::with_id(app, "open", strings.open, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", strings.quit, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("MepMail Correio")
        .on_menu_event(|handle, event| match event.id.as_ref() {
            "open" => show_main(handle),
            "quit" => handle.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn build_main_window<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let navigation_handle = app.handle().clone();
    let new_window_handle = app.handle().clone();
    let window = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
        .title("MepMail Correio")
        .inner_size(1280.0, 840.0)
        .min_inner_size(900.0, 600.0)
        .center()
        // Hidden until the splash has painted (on_page_load below), so the
        // first frame is the branded page, not an empty window. The
        // window-state plugin restores placement but not visibility.
        .visible(false)
        .theme(Some(Theme::Dark))
        .background_color(Color(0, 0, 0, 255))
        .zoom_hotkeys_enabled(true)
        .initialization_script(bridge_script())
        .on_navigation(move |url| {
            if navigation_allowed(url) {
                return true;
            }
            open_outside(&navigation_handle, url.clone());
            false
        })
        // target="_blank" and window.open: MepMail pages stay in this window,
        // everything else goes to the system browser. Never a second window.
        .on_new_window(move |url, _features| {
            if opens_in_main(&url) {
                navigate_main(&new_window_handle, url);
            } else {
                open_outside(&new_window_handle, url);
            }
            NewWindowResponse::Deny
        })
        .on_page_load(|window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                reveal(&window);
            }
        })
        .build()?;
    // Safety net: if the splash never reports a finished load, the window
    // still appears instead of leaving a process without a window.
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        reveal(&window);
    });
    Ok(())
}

/// Shows and focuses a window that is still hidden; a no-op once visible.
fn reveal<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    if window.is_visible().unwrap_or(true) {
        return;
    }
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        // Registered first, as its documentation asks: a second launch only
        // focuses the running window.
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|handle, _args, _cwd| {
                show_main(handle);
            }))
            .plugin(
                // Placement only: visibility is the shell's call (see
                // build_main_window), so a window saved hidden never starts hidden.
                tauri_plugin_window_state::Builder::default()
                    .with_state_flags(
                        tauri_plugin_window_state::StateFlags::all()
                            & !tauri_plugin_window_state::StateFlags::VISIBLE,
                    )
                    .build(),
            );
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            build_main_window(app)?;
            #[cfg(desktop)]
            build_tray(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running MepMail Correio");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).expect("valid url")
    }

    #[test]
    fn mepmail_pages_stay_in_the_webview() {
        assert!(navigation_allowed(&url("https://mepmail.dev/mail")));
        assert!(navigation_allowed(&url(
            "https://mepmail.dev/login?next=%2Fmail"
        )));
        assert!(navigation_allowed(&url(
            "https://www.mepmail.dev/mail/settings"
        )));
        assert!(navigation_allowed(&url(
            "http://tauri.localhost/index.html"
        )));
        assert!(navigation_allowed(&url("tauri://localhost/index.html")));
    }

    #[test]
    fn google_sign_in_stays_in_the_webview() {
        assert!(navigation_allowed(&url(
            "https://accounts.google.com/o/oauth2/v2/auth?x=1"
        )));
        assert!(navigation_allowed(&url(
            "https://accounts.youtube.com/accounts/SetSID"
        )));
    }

    #[test]
    fn everything_else_leaves_the_webview() {
        assert!(!navigation_allowed(&url(
            "https://checkout.stripe.com/c/pay/cs_test"
        )));
        assert!(!navigation_allowed(&url("https://docs.mepmail.dev/")));
        assert!(!navigation_allowed(&url(
            "https://docs.google.com/document/d/1"
        )));
        assert!(!navigation_allowed(&url(
            "https://meet.google.com/abc-defg-hij"
        )));
        assert!(!navigation_allowed(&url(
            "https://www.google.com/search?q=x"
        )));
        assert!(!navigation_allowed(&url(
            "https://evil.example/mepmail.dev"
        )));
        assert!(!navigation_allowed(&url("https://mepmail.dev.example/")));
        assert!(!navigation_allowed(&url("mailto:jean@mepmail.dev")));
        assert!(!navigation_allowed(&url(
            "ms-windows-store://pdp/?productid=1"
        )));
    }

    #[test]
    fn new_windows_only_reuse_the_main_window_for_mepmail_pages() {
        assert!(opens_in_main(&url("https://mepmail.dev/mail/settings")));
        assert!(opens_in_main(&url("https://www.mepmail.dev/emails")));
        assert!(!opens_in_main(&url(
            "https://accounts.google.com/o/oauth2/v2/auth"
        )));
        assert!(!opens_in_main(&url("https://docs.mepmail.dev/")));
        assert!(!opens_in_main(&url("blob:https://mepmail.dev/3f2a")));
        assert!(!opens_in_main(&url("about:blank")));
        assert!(!opens_in_main(&url("tauri://localhost/index.html")));
    }

    #[test]
    fn only_web_and_mail_links_open_outside() {
        assert!(opens_outside(&url("https://checkout.stripe.com/")));
        assert!(opens_outside(&url("mailto:jean@mepmail.dev")));
        assert!(opens_outside(&url(
            "cursor://anysphere.cursor-deeplink/prompt?text=hi"
        )));
        assert!(!opens_outside(&url("ms-windows-store://pdp/?productid=1")));
        assert!(!opens_outside(&url("file:///C:/Windows/notepad.exe")));
    }
}
