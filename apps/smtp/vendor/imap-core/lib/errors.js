'use strict';

// MepMail: stands in for WildDuck's lib/errors.js (GELF reporting), which imap-core
// only calls to log connection errors.
module.exports.notifyConnection = (connection, err) => {
    if (err && err.code === 'ECONNRESET') {
        return;
    }
    console.error('imap connection error', (err && err.message) || err); // eslint-disable-line no-console
};

module.exports.notify = err => {
    console.error('imap error', (err && err.message) || err); // eslint-disable-line no-console
};
