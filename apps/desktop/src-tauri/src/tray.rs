//! The tray icon: open the window, start with Windows, keep in the tray on
//! close, check for updates (not in the Store build, which the Store
//! updates), quit. The unread badge updates its tooltip.

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};
#[cfg(not(feature = "store"))]
use tauri_plugin_autostart::ManagerExt;

#[cfg(not(feature = "store"))]
use crate::update;
use crate::{is_portuguese, settings, show_main};

pub struct TrayHandle<R: Runtime>(pub TrayIcon<R>);

/// The "Check for updates" item, relabelled "Restart to update (x.y.z)"
/// once an update is downloaded (see `update`).
#[cfg(not(feature = "store"))]
struct UpdatesItem<R: Runtime>(MenuItem<R>);

/// Whether the app starts with Windows: the autostart plugin's Run entry,
/// or the package's StartupTask in the Store build.
fn autostart_enabled<R: Runtime>(_handle: &AppHandle<R>) -> bool {
    #[cfg(not(feature = "store"))]
    return _handle.autolaunch().is_enabled().unwrap_or(false);
    #[cfg(feature = "store")]
    return crate::packaged::startup_enabled();
}

/// Flips starting with Windows and returns the state Windows reports after.
fn toggle_autostart<R: Runtime>(handle: &AppHandle<R>) -> bool {
    let enabled = autostart_enabled(handle);
    #[cfg(not(feature = "store"))]
    {
        let manager = handle.autolaunch();
        let result = if enabled {
            manager.disable()
        } else {
            manager.enable()
        };
        if let Err(error) = result {
            eprintln!("mepmail-correio: autostart: {error}");
        }
        manager.is_enabled().unwrap_or(false)
    }
    #[cfg(feature = "store")]
    {
        crate::packaged::set_startup(!enabled).unwrap_or_else(|error| {
            eprintln!("mepmail-correio: startup task: {error}");
            autostart_enabled(handle)
        })
    }
}

struct Strings {
    open: &'static str,
    autostart: &'static str,
    keep_in_tray: &'static str,
    quit: &'static str,
}

fn strings() -> Strings {
    if is_portuguese() {
        Strings {
            open: "Abrir MepMail",
            autostart: if cfg!(windows) {
                "Iniciar com o Windows"
            } else {
                "Iniciar com o sistema"
            },
            keep_in_tray: "Manter na bandeja ao fechar",
            quit: "Sair",
        }
    } else {
        Strings {
            open: "Open MepMail",
            autostart: if cfg!(windows) {
                "Start with Windows"
            } else {
                "Start with the system"
            },
            keep_in_tray: "Keep in the tray on close",
            quit: "Quit",
        }
    }
}

pub fn build<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let strings = strings();
    let handle = app.handle();
    let autostart_on = autostart_enabled(handle);
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
    let quit = MenuItem::with_id(app, "quit", strings.quit, true, None::<&str>)?;
    let separator_top = PredefinedMenuItem::separator(app)?;
    let separator_bottom = PredefinedMenuItem::separator(app)?;
    #[cfg(not(feature = "store"))]
    let updates = MenuItem::with_id(app, "updates", update::tray_label(None), true, None::<&str>)?;
    #[cfg(not(feature = "store"))]
    let items: [&dyn tauri::menu::IsMenuItem<R>; 7] = [
        &open,
        &separator_top,
        &autostart,
        &keep,
        &separator_bottom,
        &updates,
        &quit,
    ];
    #[cfg(feature = "store")]
    let items: [&dyn tauri::menu::IsMenuItem<R>; 6] = [
        &open,
        &separator_top,
        &autostart,
        &keep,
        &separator_bottom,
        &quit,
    ];
    let menu = Menu::with_items(app, &items)?;

    let autostart_item = autostart.clone();
    let keep_item = keep.clone();
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("MepMail")
        .on_menu_event(move |handle, event| match event.id.as_ref() {
            "open" => show_main(handle),
            "autostart" => {
                // Off the menu callback: the StartupTask answers asynchronously.
                let handle = handle.clone();
                let item = autostart_item.clone();
                std::thread::spawn(move || {
                    let _ = item.set_checked(toggle_autostart(&handle));
                });
            }
            "keep_in_tray" => {
                let next = settings::update(handle, |settings| {
                    settings.keep_in_tray = !settings.keep_in_tray;
                });
                let _ = keep_item.set_checked(next.keep_in_tray);
            }
            #[cfg(not(feature = "store"))]
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
    #[cfg(not(feature = "store"))]
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
#[cfg(not(feature = "store"))]
pub fn set_updates_label<R: Runtime>(handle: &AppHandle<R>, text: &str) {
    if let Some(item) = handle.try_state::<UpdatesItem<R>>() {
        let _ = item.0.set_text(text);
    }
}
