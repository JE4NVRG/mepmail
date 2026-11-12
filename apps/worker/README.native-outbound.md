# Native Correio outbound-region configuration

Operator-only, explicit per-team/domain bindings. Keep the inbound region, MX, and receipt rules unchanged.

```dotenv
# Native Correio: private configuration sets ONLY, no campaign Open/Click rewriting.
# Example: {"us-east-1":"mepmail-private","eu-west-1":"mepmail-private"}
MAILBOX_SES_CONFIGURATION_SETS=
# Exact outbound-only binding; NEVER changes domains.region, MX, or inbound rules.
# Array of exact lowercase UUID/name bindings in a supported SES region; no wildcards/duplicates/extra keys.
# Example: [{"teamId":"11111111-1111-4111-8111-111111111111","domainId":"22222222-2222-4222-8222-222222222222","domain":"example.com","region":"eu-west-1"}]
# No entry preserves original-region pauses. NOT automatic failover; never retries another region/provider.
# Destination needs verified identity/DKIM, private configset, trusted SNS_TOPIC_ARNS, healthy quota/rate.
# SES_TENANTS requires healthy regional tenant + identity/private-set associations; failure defers, never untagged.
# Preserve original DB tenant metadata. Keep bindings + trusted topics for late receipts after stopping sends.
# Original-region historical evidence remains accepted. No inbound/MX migration or data mutation required.
MAILBOX_SES_OUTBOUND_REGIONS=
```

This configuration is read by the worker. The general bootstrap template remains byte-identical to .env.example; this opt-in must be provisioned and validated before activation.
