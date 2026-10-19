//! `mepmail://` links: a notification, a browser page or another app can
//! bring the window to the inbox. Only `mepmail://mail[/path]` and
//! `mepmail://open` are honored; everything else is ignored.
//!
//! `mailto:` links open the composer: the system hands them over as an
//! argument when MepMail is the default mail app (the installer only offers
//! it in Default apps; the person chooses), and a mail link clicked inside
//! the app stays in it.

use tauri::Url;
#[cfg(desktop)]
use tauri::{AppHandle, Runtime};
#[cfg(desktop)]
use tauri_plugin_deep_link::DeepLinkExt;

use crate::CORREIO_URL;
#[cfg(desktop)]
use crate::{navigate_main, show_main};

/// The hosted page a deep link maps to, if any. (Phones get the hosted app's
/// own https links later, through app links; `mepmail://` is desktop only.)
#[cfg_attr(mobile, allow(dead_code))]
pub fn route(url: &Url) -> Option<Url> {
    if url.scheme() != "mepmail" {
        return None;
    }
    let mut target = Url::parse(CORREIO_URL).ok()?;
    match url.host_str() {
        Some("mail") => {
            let path = url.path().trim_end_matches('/');
            if !path.is_empty() {
                target.set_path(&format!("/mail{path}"));
            }
            target.set_query(url.query());
            Some(target)
        }
        Some("open") | None => Some(target),
        _ => None,
    }
}

/// Longer links are refused rather than cut (a cut body would mislead).
const MAX_MAILTO: usize = 16_000;

/// The composer page for a `mailto:` link: /mail?mailto=<link>, which the
/// hosted app reads (lib/mailbox-mailto.ts there). Nothing is sent from it.
pub fn mailto_route(link: &str) -> Option<Url> {
    let link = link.trim();
    let is_mailto = link
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("mailto:"));
    if !is_mailto || link.len() > MAX_MAILTO {
        return None;
    }
    let mut target = Url::parse(CORREIO_URL).ok()?;
    target.query_pairs_mut().append_pair("mailto", link);
    Some(target)
}

/// The first `mailto:` among the process arguments opens the composer.
/// Returns whether one did.
#[cfg(desktop)]
pub fn open_mailto_args<R: Runtime>(
    handle: &AppHandle<R>,
    args: impl IntoIterator<Item = String>,
) -> bool {
    let Some(target) = args.into_iter().find_map(|arg| mailto_route(&arg)) else {
        return false;
    };
    navigate_main(handle, target);
    show_main(handle);
    true
}

#[cfg(desktop)]
fn open<R: Runtime>(handle: &AppHandle<R>, url: &Url) {
    match route(url) {
        Some(target) => {
            navigate_main(handle, target);
            show_main(handle);
        }
        None => eprintln!("mepmail-correio: ignored deep link {url}"),
    }
}

#[cfg(desktop)]
pub fn install<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    // The installer registers the scheme (on Linux the .deb/.rpm menu entry
    // declares it); a debug build registers it itself, and so does an
    // AppImage, which has no installer.
    #[cfg(any(debug_assertions, target_os = "linux"))]
    if cfg!(debug_assertions) || std::env::var_os("APPIMAGE").is_some() {
        if let Err(error) = app.deep_link().register_all() {
            eprintln!("mepmail-correio: deep link registration: {error}");
        }
    }
    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            open(&handle, &url);
        }
    });
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            open(app.handle(), &url);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).expect("valid url")
    }

    #[test]
    fn maps_mail_links_onto_the_hosted_app() {
        assert_eq!(
            route(&url("mepmail://mail")).unwrap().as_str(),
            "https://mepmail.dev/mail"
        );
        assert_eq!(
            route(&url("mepmail://mail/settings")).unwrap().as_str(),
            "https://mepmail.dev/mail/settings"
        );
        assert_eq!(
            route(&url("mepmail://mail?item=abc")).unwrap().as_str(),
            "https://mepmail.dev/mail?item=abc"
        );
        assert_eq!(
            route(&url("mepmail://open")).unwrap().as_str(),
            "https://mepmail.dev/mail"
        );
    }

    #[test]
    fn mail_links_open_the_composer_with_the_whole_link() {
        let target = mailto_route("mailto:maya@example.com?subject=Oi%20Maya&body=a%26b").unwrap();
        assert_eq!(target.path(), "/mail");
        assert_eq!(
            target
                .query_pairs()
                .find(|(key, _)| key == "mailto")
                .unwrap()
                .1,
            "mailto:maya@example.com?subject=Oi%20Maya&body=a%26b"
        );
        assert!(mailto_route("MAILTO:jean@mepmail.dev").is_some());
        assert!(mailto_route("https://mepmail.dev").is_none());
        assert!(mailto_route("mepmail://mail").is_none());
        assert!(mailto_route(&format!("mailto:a@b.co?body={}", "x".repeat(16_000))).is_none());
    }

    #[test]
    fn ignores_everything_else() {
        assert!(route(&url("mepmail://evil.example/x")).is_none());
        assert!(route(&url("https://mepmail.dev/mail")).is_none());
        assert!(route(&url("mailto:jean@mepmail.dev")).is_none());
    }
}
