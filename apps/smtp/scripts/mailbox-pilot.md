# Local mailbox product qualification

This executable prototype qualifies a personal and an agent mailbox under the synthetic `piloto.test` domain. It is not deployed to MepMail production and does not provision a real mailbox, MX, AWS resource or IAM grant.

The shared core is provider-independent. Existing locked `mailparser@3.9.26` and `nodemailer@10.0.3` parse and compose real MIME. Incoming envelope recipients route messages; the visible `To` header cannot route mail. Attachments and the original MIME stay in the same private AES-GCM snapshot, bound to the fixture team. Responses carry `In-Reply-To` and `References` and preserve selected attachment bytes.

Jean's synthetic identity can read, draft, send and manage both boxes. Luna's synthetic identity can only read and draft in its own box. The HTTP driver obtains those identities from an opaque HttpOnly session cookie and a server-side fixture map. The selector deliberately switches demo identities; it is not a login method for production. Email body text is untrusted input, rendered with `textContent`; HTML, tracking images and agent instructions are not executed.

Sending captures only an idempotency key in this process. A sent MIME copy appears in the same thread. There is no external transport. Changing a production adapter to SES requires a durable outbox and reconciliation around acknowledgement and persistence failures, not this in-memory capture.

The fixture store serializes changes in one process, checks a bounded 4 MiB capacity before transport, and atomically replaces the encrypted snapshot. It is not a distributed database or a crash-durability claim. Tests qualify reopen, restoration with the same key/team, corruption rejection, attachment hashes, retries, revocation during MIME parsing and permission boundaries. Pilot message size is 1 MiB; at most 10 attachments of 256 KiB each are accepted. These are qualification limits, not advertised product quotas.

For an existing local checkout with dependencies installed, from `apps/smtp`:

```powershell
$env:MEPMAIL_LOCAL_PILOT = '1'
$env:NODE_ENV = 'test'
pnpm exec tsx scripts/mailbox-pilot.mts
```

Open `http://127.0.0.1:3186`. The direct runner binds only loopback. A Linux container may set `MEPMAIL_LOCAL_PILOT_PORT=3000` and must publish it exclusively as `127.0.0.1:3186:3000`. The current proof reuses the cached local dependency image; it downloads nothing and receives no production credentials. Fixture key and ciphertext are private temporary files. Do not enter real email or credentials into the fixture UI. Keep this preview only while reviewing this candidate; remove its owned temporary runner after integration or closure.

Next qualification: production-authenticated mailbox ownership and API/MCP grants, a full mailbox core with client synchronization and threading, a private raw MIME ingress adapter, and recoverable outbound delivery. Before commercial hosting, validate tenant isolation, quotas, licensing, operator controls, backup/restore and spam/virus handling. No real domain MX changes or Purelymail migration belong to this local proof.
