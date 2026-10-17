# Signup risk data and lookup limits

Version 1 snapshots retrieved on 2026-10-17. These are weak observations, not a list of abusive customers or an automatic ASN/TLD ban. The previously held signup cohort is not ground truth for policy accuracy.

## Disposable domain snapshot

- Source: [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains), `disposable_email_blocklist.conf`.
- The exact source already collected for this task is `.local-wip-preserved/signup-risk-20261017/disposable-blocklist-source.conf`.
- Original SHA-256: `5052d5eebd1b8907738dbbf3f1f4cd961593c14f44435674bc6d8a34986009a7`.
- Vendored JSON contains 9,892 unique lowercase domains, sorted, with the source digest and license metadata. Exact domains and their subdomains match; unrelated suffix lookalikes do not.
- Formatted vendored `disposable-domains.json` SHA-256: `551822c05c06aabb33fe47b3dc9c8aa3e8be1947dae45a49b1ead7df98f78b4f`.
- License: CC0-1.0. The upstream [LICENSE.txt](https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/LICENSE.txt) is preserved as `LICENSE-disposable-domains.txt`, SHA-256 `71e4e05374bd16288e638ede168482f8642204fdb90aede848c9fcdf44730026`.
- Absence from this snapshot does not establish a mailbox is permanent or safe. The snapshot does not cover the newly observed coordinated domain cohort.

## RDAP bootstrap

- [IANA DNS RDAP bootstrap](https://data.iana.org/rdap/dns.json), publication `2026-09-30T23:00:03Z`, 592 service entries. Only whitespace/line endings were formatted for the repository; parsed JSON equality was checked.
- Original response SHA-256: `e3419eb0b28dcc3a68dd3bb0e64429cb0d376c3883ca4c42317aea65fc0ab471`.
- Formatted vendored `rdap-dns.json` SHA-256: `16e3009229e041b239f95e9d3de080f9f597b419fba7fb2a1fd723b397b2930c`.
- Bootstrap selection follows [RFC 9224](https://www.rfc-editor.org/rfc/rfc9224). Domain events follow [RFC 9083](https://www.rfc-editor.org/rfc/rfc9083).
- Runtime never downloads or extends the bootstrap. Only its fixed HTTPS registry endpoints may be used; no redirects, credentials, nondefault ports, alternate response URLs or server links from a response. Query paths are constructed from a strictly validated ASCII domain and the existing curated registrable-domain helper. Unsupported suffixes and missing records remain unknown.
- Responses are bounded to 128 KiB and the shared two-second collection deadline. Only the matching domain's earliest registration instant is extracted; registration owner/entity details are never returned, cached or persisted by this collector. Future or invalid dates remain unknown.

## MX and ASN

- MX resolution distinguishes a present record, a null MX, absence and lookup failure. It does not test SMTP or infer catch-all behavior. `catchAll` always remains `unknown`.
- [Team Cymru IP-to-ASN DNS mapping](https://www.team-cymru.com/ip-asn-mapping): reversed IPv4 octets under `origin.asn.cymru.com`, full reversed IPv6 hexadecimal nibbles under `origin6.asn.cymru.com`.
- Only canonical public IPs may form an ASN query. Private, loopback, documentation and other special-use ranges stay unknown. IPv4-mapped IPv6 is canonicalized to the same IPv4 identity. Multiple or malformed origin ASNs remain unknown.
- IP persistence uses HMAC-SHA256 with the existing runtime secret and a versioned namespace; no raw IP is included in returned signals or logs. Missing IP remains null. No lookup was performed against a customer's real IP during implementation.
- Reserved test/example/internal domains perform no network lookup, including ASN. No SMTP/catch-all probe, paid enrichment service or customer contact is used.

## Policy and runtime bounds

- One private collector owns at most 512 domain entries and 512 ASN entries, FIFO eviction and a ten-minute TTL. Cached values include only MX/registration date or ASN; not HTTP bodies, emails, credentials or raw IPs. Cold requests run concurrently under one two-second abort deadline; DNS resolvers use one attempt and 650 ms timeout.
- Policy v1 uses bursts of at least 3 signups/IP/hour, 3/domain/day or 12/ASN/hour only in combination with an identity signal. ASN/IP, randomness, age, TLD and fast API-key creation alone never create a hold. Payment status is not an input.
- A disposable domain alone enters sandbox. A domain younger than thirty days combines with randomness, burst or fast key creation for sandbox; young plus random plus burst/fast key, or disposable plus random plus burst, can enter reversible review. Randomness plus burst enters sandbox at any domain age, without creating a hold for a mature domain alone. The 30-day window was calibrated against the observed cohort's public registration ages (13–27 days); it is not a predictive-accuracy estimate. Null/absent MX needs random/disposable evidence; MX failure alone does not restrict an account.
- These thresholds are conservative rules for candidate qualification, not measured predictive accuracy. They do not replace the verified sandbox principal, an existing operator hold, paid-account safeguards or transport enforcement.
