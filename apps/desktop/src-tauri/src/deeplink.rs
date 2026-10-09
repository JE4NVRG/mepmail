//! `mepmail://` links: a notification, a browser page or another app can
//! bring the window to the inbox. Only `mepmail://mail[/path]` and
//! `mepmail://open` are honored; everything else is ignored.

use tauri::{AppHandle, Runtime, Url};
use tauri_plugin_deep_link::DeepLinkExt;

use crate::{navigate_main, show_main, CORREIO_URL};

/// The hosted page a deep link maps to, if any.
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

fn open<R: Runtime>(handle: &AppHandle<R>, url: &Url) {
    match route(url) {
        Some(target) => {
            navigate_main(handle, target);
            show_main(handle);
        }
        None => eprintln!("mepmail-correio: ignored deep link {url}"),
    }
}

pub fn install<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    // The installer registers the scheme; a debug build registers it itself.
    #[cfg(debug_assertions)]
    if let Err(error) = app.deep_link().register_all() {
        eprintln!("mepmail-correio: deep link registration: {error}");
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
    fn ignores_everything_else() {
        assert!(route(&url("mepmail://evil.example/x")).is_none());
        assert!(route(&url("https://mepmail.dev/mail")).is_none());
        assert!(route(&url("mailto:jean@mepmail.dev")).is_none());
    }
}
