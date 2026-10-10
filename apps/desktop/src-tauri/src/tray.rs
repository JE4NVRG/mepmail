//! The tray icon: open the window, start with Windows, keep in the tray on
//! close, check for updates, quit. The unread badge updates its tooltip.

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};
use tauri_plugin_autostart::ManagerExt;

use crate::{is_portuguese, settings, show_main, update};

pub struct TrayHandle<R: Runtime>(pub TrayIcon<R>);

/// The "Check for updates" item, relabelled "Restart to update (x.y.z)"
/// once an update is downloaded (see `update`).
struct UpdatesItem<R: Runtime>(MenuItem<R>);

struct Strings {
    open: &'static str,
    autostart: &'static str,
    keep_in_tray: &'static str,
    quit: &'static str,
}

fn strings() -> Strings {
    if is_portuguese() {
        Strings {
            open: "Abrir Correio",
            autostart: "Iniciar com o Windows",
            keep_in_tray: "Manter na bandeja ao fechar",
            quit: "Sair",
        }
    } else {
        Strings {
            open: "Open Correio",
            autostart: "Start with Windows",
            keep_in_tray: "Keep in the tray on close",
            quit: "Quit",
        }
    }
}

pub fn build<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let strings = strings();
    let handle = app.handle();
    let autostart_on = handle.autolaunch().is_enabled().unwrap_or(false);
    let keep_in_tray = settings::current(handle).keep_in_tray;

    let open = MenuItem::with_id(app, "open", strings.open, true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        strings.autostart,
        true,
        autostart_on,
        None::<&str>,
    )?;
    let keep = CheckMenuItem::with_id(
        app,
        "keep_in_tray",
        strings.keep_in_tray,
        true,
        keep_in_tray,
        None::<&str>,
    )?;
    let updates = MenuItem::with_id(app, "updates", update::tray_label(None), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", strings.quit, true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &autostart,
            &keep,
            &PredefinedMenuItem::separator(app)?,
            &updates,
            &quit,
        ],
    )?;

    let autostart_item = autostart.clone();
    let keep_item = keep.clone();
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("MepMail Correio")
        .on_menu_event(move |handle, event| match event.id.as_ref() {
            "open" => show_main(handle),
            "autostart" => {
                let manager = handle.autolaunch();
                let enabled = manager.is_enabled().unwrap_or(false);
                let result = if enabled {
                    manager.disable()
                } else {
                    manager.enable()
                };
                if let Err(error) = result {
                    eprintln!("mepmail-correio: autostart: {error}");
                }
                let _ = autostart_item.set_checked(manager.is_enabled().unwrap_or(false));
            }
            "keep_in_tray" => {
                let next = settings::update(handle, |settings| {
                    settings.keep_in_tray = !settings.keep_in_tray;
                });
                let _ = keep_item.set_checked(next.keep_in_tray);
            }
            "updates" => update::tray_clicked(handle),
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
    let tray = tray.build(app)?;
    app.manage(TrayHandle(tray));
    app.manage(UpdatesItem(updates));
    Ok(())
}

/// Updates the tray tooltip (the unread badge calls this).
pub fn set_tooltip<R: Runtime>(handle: &AppHandle<R>, text: &str) {
    if let Some(tray) = handle.try_state::<TrayHandle<R>>() {
        let _ = tray.0.set_tooltip(Some(text));
    }
}

/// Relabels the updates item (the updater calls this).
pub fn set_updates_label<R: Runtime>(handle: &AppHandle<R>, text: &str) {
    if let Some(item) = handle.try_state::<UpdatesItem<R>>() {
        let _ = item.0.set_text(text);
    }
}
