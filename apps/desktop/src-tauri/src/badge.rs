//! The unread badge. The hosted app mirrors "(N) Correio · MepMail" into the
//! window title; the shell reads it back and shows the count on the taskbar
//! icon plus a tray tooltip, so unread mail is visible with the window
//! minimized. The installer build draws the number into the taskbar overlay
//! icon (1 to 9, then "9+"); the Store build uses the package's own taskbar
//! badge, which Windows draws, and falls back to the overlay.

use std::time::Duration;

use tauri::{image::Image, AppHandle, Manager, Runtime, WebviewWindow};

use crate::{is_portuguese, tray, MAIN_WINDOW};

/// The overlay's logical size; it is drawn at the window's scale (16, 32, 48 px).
const BASE: u32 = 16;
/// Disc colour: a red dark enough for white digits to stay legible.
const DISC: [u8; 3] = [0xd2, 0x3b, 0x31];

/// 5×7 glyphs for 0-9 and "+", one row per byte, the five low bits used.
const GLYPHS: [[u8; 7]; 11] = [
    [
        0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110,
    ],
    [
        0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
    ],
    [
        0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111,
    ],
    [
        0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110,
    ],
    [
        0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
    ],
    [
        0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110,
    ],
    [
        0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110,
    ],
    [
        0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000,
    ],
    [
        0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
    ],
    [
        0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100,
    ],
    [
        0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000,
    ],
];
const GLYPH_W: u32 = 5;
const GLYPH_H: u32 = 7;

/// "(3) Correio · MepMail" → 3; a title without the prefix → 0.
pub fn unread_from_title(title: &str) -> u32 {
    let rest = match title.strip_prefix('(') {
        Some(rest) => rest,
        None => return 0,
    };
    let Some(end) = rest.find(')') else { return 0 };
    rest[..end].trim().parse().unwrap_or(0)
}

/// What the overlay shows: nothing, a digit, or "9+".
fn label(unread: u32) -> &'static str {
    const DIGITS: [&str; 10] = ["", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
    match unread {
        0..=9 => DIGITS[unread as usize],
        _ => "9+",
    }
}

fn glyph(character: char) -> Option<&'static [u8; 7]> {
    match character {
        '0'..='9' => Some(&GLYPHS[character as usize - '0' as usize]),
        '+' => Some(&GLYPHS[10]),
        _ => None,
    }
}

/// A square RGBA badge `BASE * scale` pixels wide: a red disc with the
/// label in white, centred.
fn badge(unread: u32, scale: u32) -> (Vec<u8>, u32) {
    let scale = scale.clamp(1, 3);
    let size = BASE * scale;
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);
    let center = (size as f32 - 1.0) / 2.0;
    let radius = size as f32 / 2.0 - 0.5 * scale as f32;
    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let distance = (dx * dx + dy * dy).sqrt();
            let coverage = (radius - distance + 0.5).clamp(0.0, 1.0);
            rgba.extend_from_slice(&[DISC[0], DISC[1], DISC[2], (coverage * 255.0) as u8]);
        }
    }
    let text = label(unread);
    let glyphs: Vec<&[u8; 7]> = text.chars().filter_map(glyph).collect();
    if glyphs.is_empty() {
        return (rgba, size);
    }
    let count = glyphs.len() as u32;
    let width = (count * GLYPH_W + (count - 1)) * scale;
    let height = GLYPH_H * scale;
    let left = (size.saturating_sub(width)) / 2;
    let top = (size.saturating_sub(height)) / 2;
    for (index, rows) in glyphs.iter().enumerate() {
        let origin = left + index as u32 * (GLYPH_W + 1) * scale;
        for (row, bits) in rows.iter().enumerate() {
            for column in 0..GLYPH_W {
                if bits & (1 << (GLYPH_W - 1 - column)) == 0 {
                    continue;
                }
                for sy in 0..scale {
                    for sx in 0..scale {
                        let x = origin + column * scale + sx;
                        let y = top + row as u32 * scale + sy;
                        if x >= size || y >= size {
                            continue;
                        }
                        let at = ((y * size + x) * 4) as usize;
                        rgba[at..at + 3].copy_from_slice(&[0xff, 0xff, 0xff]);
                    }
                }
            }
        }
    }
    (rgba, size)
}

fn tooltip(unread: u32) -> String {
    match (unread, is_portuguese()) {
        (0, _) => "MepMail".to_string(),
        (1, true) => "MepMail · 1 não lida".to_string(),
        (n, true) => format!("MepMail · {n} não lidas"),
        (n, false) => format!("MepMail · {n} unread"),
    }
}

fn set_overlay<R: Runtime>(window: &WebviewWindow<R>, unread: u32) {
    if unread == 0 {
        let _ = window.set_overlay_icon(None);
        return;
    }
    let scale = window
        .scale_factor()
        .map(|factor| factor.round() as u32)
        .unwrap_or(1);
    let (rgba, size) = badge(unread, scale);
    let _ = window.set_overlay_icon(Some(Image::new(&rgba, size, size)));
}

fn apply<R: Runtime>(handle: &AppHandle<R>, window: &WebviewWindow<R>, unread: u32) {
    #[cfg(feature = "store")]
    {
        if crate::packaged::set_badge(unread).is_ok() {
            let _ = window.set_overlay_icon(None);
        } else {
            set_overlay(window, unread);
        }
    }
    #[cfg(not(feature = "store"))]
    set_overlay(window, unread);
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
    fn labels_stop_at_nine() {
        assert_eq!(label(0), "");
        assert_eq!(label(7), "7");
        assert_eq!(label(10), "9+");
        assert_eq!(label(4200), "9+");
    }

    #[test]
    fn the_badge_is_a_disc_with_white_digits_at_every_scale() {
        for scale in 1..=3 {
            let (rgba, size) = badge(1, scale);
            assert_eq!(size, BASE * scale);
            assert_eq!(rgba.len(), (size * size * 4) as usize);
            let pixel = |x: u32, y: u32| {
                let at = ((y * size + x) * 4) as usize;
                [rgba[at], rgba[at + 1], rgba[at + 2], rgba[at + 3]]
            };
            assert_eq!(pixel(0, 0)[3], 0, "corner stays clear");
            let white = (0..size)
                .flat_map(|y| (0..size).map(move |x| (x, y)))
                .filter(|&(x, y)| pixel(x, y) == [0xff, 0xff, 0xff, 0xff])
                .count();
            // The "1" glyph has 10 lit cells, each scale×scale pixels.
            assert_eq!(white as u32, 10 * scale * scale);
        }
    }

    #[test]
    fn nine_plus_fits_inside_the_disc() {
        let (rgba, size) = badge(42, 1);
        let lit = |x: u32, y: u32| {
            let at = ((y * size + x) * 4) as usize;
            rgba[at] == 0xff && rgba[at + 3] == 0xff
        };
        for y in 0..size {
            assert!(
                !lit(0, y) && !lit(size - 1, y),
                "digits never touch the edge"
            );
        }
    }
}
