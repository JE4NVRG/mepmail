# Integration logos

Monochrome white SVG marks, vendored so the site never hotlinks a third party
(CSP keeps `img-src` on `'self'` for these, and a CDN outage cannot break the
page).

Source: [simple-icons](https://simpleicons.org) — CC0 1.0 Universal, no
attribution required; files were downloaded once and committed:

- `n8n`, `discord`, `telegram`, `nodedotjs`, `python`, `php`, `ruby`, `go`,
  `docker`, `curl`: `https://cdn.simpleicons.org/<slug>/ffffff`
- `slack`: `https://cdn.jsdelivr.net/npm/simple-icons@15.0.0/icons/slack.svg`
  with `fill="#ffffff"` added to the root `<svg>` (the mark was dropped from the
  simple-icons catalog after that release, so the last published version is
  vendored).

Every file keeps `viewBox="0 0 24 24"` and a white fill, so the marks read on
the dark ground. The slug list lives in `src/lib/stack-logos.ts`.
