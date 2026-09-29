# Landing CRO — scoped PRD

Direction owner: Luna. Request: improve MepMail acquisition through an outcome-led landing with real product evidence. Implementation is preview-only; conversion lift remains an unmeasured hypothesis.

The complete direction and acceptance criteria are preserved in [landing-cro-spec](gtm/landing-cro-spec.md). The scope guardrails are in [constitution](../specs/constitution.md). Issue: https://github.com/JE4NVRG/mepmail/issues/45.

Deliver EN/PT home, real cropped product screenshot, accessible integration tabs, MCP before plans, Free/Starter/Pro 110K upfront, comparison after plans, short activation steps and signup CTAs. Preserve header/footer v2, attribution and event names, plan catalog and all existing routes.

Acceptance: native Windows web build, relevant tests/Biome/TypeScript, real preview on Windows loopback 9897, EN/PT at 1440×1000, 768×1024, 390×844 and 375×667, no horizontal overflow or render errors, mobile primary CTA before y=600. Verify navigation, keyboard tabs/menu, disclosures, language and signup links without submitting accounts or payments. Independent QA and Luna visual review follow implementation.

No release, production changes, billing/auth/quotas redesign, real database access or external email. Reuse the existing branch and F:\MepMail; keep recoverable pre-existing WIP separate. Deployment is not authorized: publish only after later Jean approval, using the validated artifact and the local-first delivery standard.
