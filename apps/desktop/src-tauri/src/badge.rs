//! The unread badge. The hosted app mirrors "(N) Correio · MepMail" into the
//! window title; the shell reads it back and shows a taskbar overlay plus a
//! tray tooltip, so unread mail is visible with the window minimized.

use std::time::Duration;

use tauri::{image::Image, AppHandle, Manager, Runtime, WebviewWindow};

use crate::{is_portuguese, tray, MAIN_WINDOW};

const SIZE: u32 = 16;

/// "(3) Correio · MepMail" → 3; a title without the prefix → 0.
pub fn unread_from_title(title: &str) -> u32 {
    let rest = match title.strip_prefix('(') {
        Some(rest) => rest,
        None => return 0,
    };
    let Some(end) = rest.find(')') else { return 0 };
    rest[..end].trim().parse().unwrap_or(0)
}

/// A 16×16 RGBA disc in the danger tone of the design tokens.
fn dot() -> Vec<u8> {
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    let center = (SIZE as f32 - 1.0) / 2.0;
    let radius = SIZE as f32 / 2.0 - 1.0;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let distance = (dx * dx + dy * dy).sqrt();
            let coverage = (radius - distance + 0.5).clamp(0.0, 1.0);
            rgba.extend_from_slice(&[0xe0, 0x7f, 0x76, (coverage * 255.0) as u8]);
        }
    }
    rgba
}

fn tooltip(unread: u32) -> String {
    match (unread, is_portuguese()) {
        (0, _) => "MepMail Correio".to_string(),
        (1, true) => "MepMail Correio · 1 não lida".to_string(),
        (n, true) => format!("MepMail Correio · {n} não lidas"),
        (n, false) => format!("MepMail Correio · {n} unread"),
    }
}

fn apply<R: Runtime>(handle: &AppHandle<R>, window: &WebviewWindow<R>, unread: u32) {
    if unread > 0 {
        let rgba = dot();
        let _ = window.set_overlay_icon(Some(Image::new(&rgba, SIZE, SIZE)));
    } else {
        let _ = window.set_overlay_icon(None);
    }
    tray::set_tooltip(handle, &tooltip(unread));
}

/// Polls the window title every few seconds and applies changes only.
pub fn watch<R: Runtime>(handle: AppHandle<R>) {
    let _ = tauri::async_runtime::spawn(async move {
        let mut last: Option<u32> = None;
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let Some(window) = handle.get_webview_window(MAIN_WINDOW) else {
                continue;
            };
            let Ok(title) = window.title() else { continue };
            let unread = unread_from_title(&title);
            if last == Some(unread) {
                continue;
            }
            last = Some(unread);
            apply(&handle, &window, unread);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_unread_prefix() {
        assert_eq!(unread_from_title("(3) Correio · MepMail"), 3);
        assert_eq!(unread_from_title("(120) Correio"), 120);
        assert_eq!(unread_from_title("Correio · MepMail"), 0);
        assert_eq!(unread_from_title("(x) Correio"), 0);
        assert_eq!(unread_from_title(""), 0);
    }

    #[test]
    fn the_dot_is_opaque_in_the_middle_and_clear_in_the_corners() {
        let rgba = dot();
        assert_eq!(rgba.len(), (SIZE * SIZE * 4) as usize);
        let at = |x: u32, y: u32| rgba[((y * SIZE + x) * 4 + 3) as usize];
        assert_eq!(at(8, 8), 255);
        assert_eq!(at(0, 0), 0);
    }
}
