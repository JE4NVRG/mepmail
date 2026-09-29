# Integration logos

The vendor's own full-colour marks, vendored so the site never hotlinks a third
party (CSP keeps `img-src` on `'self'`, and a CDN outage cannot break the page).
Every file is the official artwork in its official brand colour — the previous
monochrome white set was replaced because grey-on-near-black marks were barely
legible and several were unrecognisable at strip size.

## Sources

| File | Source |
| --- | --- |
| `n8n.svg` | [N8n-logo-new.svg](https://commons.wikimedia.org/wiki/File:N8n-logo-new.svg) (Wikimedia Commons) |
| `slack.svg` | [Slack icon 2019.svg](https://commons.wikimedia.org/wiki/File:Slack_icon_2019.svg) |
| `discord.svg` | [cdn.simpleicons.org/discord/5865F2](https://cdn.simpleicons.org/discord/5865F2) — Clyde mark in Discord blurple |
| `telegram.svg` | [Telegram 2019 Logo.svg](https://commons.wikimedia.org/wiki/File:Telegram_2019_Logo.svg) |
| `nodedotjs.svg` | [nodejs.org/static/logos/nodejsLight.svg](https://nodejs.org/static/logos/nodejsLight.svg) — Node.js' own light-on-dark lockup (green hexagons, white wordmark). The Commons derivative `Node.js logo light-on-dark.svg` was rejected: it carries an extra hexagon inside the `e`. |
| `python.svg` | [Python-logo-notext.svg](https://commons.wikimedia.org/wiki/File:Python-logo-notext.svg) |
| `php.svg` | [PHP-logo.svg](https://commons.wikimedia.org/wiki/File:PHP-logo.svg) |
| `ruby.svg` | [Ruby logo.svg](https://commons.wikimedia.org/wiki/File:Ruby_logo.svg) |
| `go.svg` | [Go Logo Blue.svg](https://commons.wikimedia.org/wiki/File:Go_Logo_Blue.svg) |
| `docker.svg` | [Docker Logo.svg](https://commons.wikimedia.org/wiki/File:Docker_Logo.svg) (current blue lockup; the older `Docker (container engine) logo.svg` is dimmer and was dropped) |
| `curl.svg` | [Curl-logo.svg](https://commons.wikimedia.org/wiki/File:Curl-logo.svg), mirrored from [curl.se/logo](https://curl.se/logo/) |

curl's page grants use of the images to show that a product uses curl, including
resizing and self-hosting. Discord's mark comes from simple-icons (CC0 1.0),
which traces the official artwork; the Wikimedia Commons set is public
domain / CC0 for logo use.

## Three deliberate treatments

The artwork is used as published except where the published inks cannot read on
a near-black ground (`--ms-void: #000`). Each deviation is minimal and keeps hue
and saturation:

- **`n8n.svg`** — the published file inks the wordmark `#101330` (its light
  background treatment). The wordmark is recoloured to n8n's brand pink
  `#EA4B71`, matching the node symbol already in the file.
- **`curl.svg`** — curl publishes the lockup only for light backgrounds
  (`curl-logo.svg`, inks `#073551` / `#0c544c`) plus a white *symbol* variant.
  The lockup keeps its geometry with the lettering lifted to `#FFFFFF` and the
  slashes to `#2FC4B2`, the same hue as curl's `#0f564d` lightened for black.
- **`ruby.svg`** — the gem is drawn for white backgrounds and its darkest
  facets sit near 2:1 over black. Lightness only is gamma-lifted (`l^0.8`) so the
  mark reads at strip size; hue and saturation are untouched.

## Sizing contract

Every file's `viewBox` is the **ink** bounding box (measured with `getBBox`, not
the file's original padding) and the root `width`/`height` attributes are
removed. That is what lets the CSS normalise marks by height: a lockup with
internal whitespace no longer renders visually smaller than its neighbours. The
width of each mark is `height × ratio`, where `ratio` lives next to the slug in
`src/lib/stack-logos.ts`.
