'use strict';

const crypto = require('crypto');

// Expose to the world
module.exports = getTLSOptions;

// MepMail: upstream's built-in default key and certificate (publicly known) were removed
// on purpose. Without a keypair from the caller there is no TLS handshake at all (fail
// closed), never TLS with a key the whole world has. The minimum version is TLS 1.2.
const tlsDefaults = {
    honorCipherOrder: true,
    requestOCSP: false,
    sessionIdContext: crypto.createHash('sha1').update(process.argv.join(' ')).digest('hex').slice(0, 32),
    minVersion: 'TLSv1.2'
};

/**
 * Mixes existing values with the default ones.
 *
 * @param {Object} [opts] TLS options
 * @returns {Object} Object with mixed TLS values
 */
function getTLSOptions(opts) {
    return Object.assign({}, tlsDefaults, opts || {});
}
