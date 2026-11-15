# Explicit text-only Native drafts

`mailbox_save_draft` accepts optional `message_format: "plain_text"` on all three Correio surfaces (npm, hosted Correio, hosted OAuth). The HTTP draft API maps this to `messageFormat: "plain_text"`.

```json
{
  "to": ["recipient@example.invalid"],
  "subject": "A new correspondence draft",
  "text": "The complete authored message.",
  "expected_revision": 0,
  "message_format": "plain_text"
}
```

This explicit choice creates a **new** `text/plain` MIME message with the mailbox's textual signature, including the full website target. It sends no logo, HTML alternative or attachment. Existing provider policy still determines whether required optout text and List-Unsubscribe headers are added. The From address, To/Cc/Bcc and reply/forward threading rules are unchanged. Native has no authored Reply-To input in this contract: the effective reply address remains the mailbox's own From, not the source message's Reply-To.

- Omit the parameter to preserve the existing formatted MIME default, including its managed signature HTML/logo.
- The explicit variant requires no draft `id`, revision 0, no rich HTML (even empty HTML is rejected), no uploaded or retained attachments, and no draft as its source. It can start a new message, reply to an authorized Inbox/Sent source, or forward under the existing source rules.
- The existing MCP forward attachment defaults are **not** changed. A forward that retains files is refused for this variant. An explicit empty `keep_attachments` is needed when intentionally composing a new text-only forward without those files.
- Do not use this flag to convert an existing draft. Rejected updates preserve the original MIME/revision. Do not strip a logo or rewrite legacy draft/outbox content to qualify it.
- Save, review the actual final body and envelope, then use the normal send/approval path for that exact saved ID and revision. This format choice is **not semantic approval**, consent, recipient authorization or a delivery receipt. The final sealed bytes, signature claims/links and all recipients still require the normal qualifier. Unsupported visual content is not granted a bypass.
- Existing composition v1 receipts apply only to their existing default agent reply contract. This variant emits no v1 composition receipt and cannot be requalified as v1.
- This bounded change exposes the choice in MCP/API only. The visual compose UI does not expose it. A later UI save without the option still follows the existing formatting behavior; do not use the UI as a text-format-preserving editor for these drafts. Editing the explicit variant is unsupported: compose a new draft from reviewed structured input, preserving the original.

No database migration or rewrite of MIME/history/outbox is required. Authentication, consent, sending holds, suppression, region/provider dispatch and semantic qualification remain owned by their existing boundaries.
