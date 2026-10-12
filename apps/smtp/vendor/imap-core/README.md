# imap-core (vendored)

The IMAP protocol layer of [WildDuck](https://github.com/zone-eu/wildduck) 1.46.1
(`imap-core/`), by Andris Reinman and Zone Media OÜ, under the
[European Union Public Licence v1.2](LICENSE). The EUPL-1.2 lists the GNU AGPLv3,
MepMail's licence, as a compatible licence.

MepMail serves its Correio mailboxes over IMAP with it (`apps/smtp/src/imap/`):
the handlers there read and write mail through MepMail's own core.

Changes from upstream:

- `lib/errors.js` replaces WildDuck's `lib/errors.js` (GELF logging) with a console log.
- Connection and session ids use `crypto.randomBytes(10).toString('hex')` instead of
  `base32.js`.
- `package.json` (this folder) stands in for WildDuck's own, read for the ID response,
  and keeps the folder CommonJS inside MepMail's ESM workspace.
- `require` paths that pointed into the rest of WildDuck (`../../package`,
  `../../lib/errors.js`) point to the two files above (`lib/imap-connection.js`,
  `lib/imap-server.js`, `lib/imap-command.js`, `lib/commands/id.js`, `lib/commands/store.js`).
- `lib/imap-tools.js`: `options.disabledCapabilities` leaves capabilities out of the
  CAPABILITY response (MepMail leaves out CONDSTORE and QUOTA).
- `lib/tls-options.js`: upstream's built-in default key and certificate (publicly known)
  are removed, so there is no TLS without the caller's keypair (fail closed), and the
  minimum TLS version is 1.2 instead of 1.0.
- `test/` is left out.
