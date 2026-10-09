//! Shell preferences that survive restarts: a small JSON file in the app's
//! config directory. Autostart is not here: the autostart plugin owns it.

use std::{fs, path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Closing the window hides it to the tray instead of quitting.
    pub keep_in_tray: bool,
}

pub struct SettingsState(pub Mutex<Settings>);

fn file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("settings.json"))
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> Settings {
    file(app)
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save<R: Runtime>(app: &AppHandle<R>, settings: &Settings) {
    let Some(path) = file(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_vec_pretty(settings) {
        if let Err(error) = fs::write(&path, json) {
            eprintln!(
                "mepmail-correio: could not save {}: {error}",
                path.display()
            );
        }
    }
}

/// A snapshot of the current preferences.
pub fn current<R: Runtime>(app: &AppHandle<R>) -> Settings {
    app.try_state::<SettingsState>()
        .map(|state| {
            state
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        })
        .unwrap_or_default()
}

/// Changes the preferences, writes them to disk and returns the new snapshot.
pub fn update<R: Runtime>(app: &AppHandle<R>, change: impl FnOnce(&mut Settings)) -> Settings {
    let Some(state) = app.try_state::<SettingsState>() else {
        return Settings::default();
    };
    let snapshot = {
        let mut guard = state
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        change(&mut guard);
        guard.clone()
    };
    save(app, &snapshot);
    snapshot
}
