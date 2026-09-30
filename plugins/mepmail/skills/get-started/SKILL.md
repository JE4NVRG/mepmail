---
name: get-started
description: Help an existing MepMail user connect one team with minimal read permissions before inspecting sending domains or email delivery.
---

# Connect MepMail safely

Use this workflow only when the user asks to connect or inspect MepMail. Respond in the user's language (English or Brazilian Portuguese). Do not imply OpenAI endorsement, successful installation, authorization, or publication without evidence.

1. Explain the purpose and data access before linking. The existing service is https://api-mepmail.je4ndev.com/mcp; its authorization server is https://mepmail.je4ndev.com. Use the host's OAuth interface, never pasted passwords, API keys, cookies, access tokens or verification codes. Never create an account, OAuth client, or grant through a tool on the user's behalf.
2. Ask the user to select ONE existing team, not all teams. For domain inspection keep only `domains:read`. For email inspection keep only `emails:read`, adding `domains:read` only if requested. Do not request `offline_access` by default: reauthorization after token expiry is acceptable. Never request sending, audience, template, webhook or API-key permissions for these workflows.
3. IMPORTANT: the shared resource advertises more scopes, and the current consent screen initially selects requested permissions. Before the user approves, explain that they must deselect everything except the necessary read scopes. If the host cannot request or the user cannot select this subset, cancel linking and report the limitation; do not accept an unrestricted grant for convenience. Existing broad grants require disconnect/reconnect with the user's permission in the host UI, not automated token manipulation.
4. Consent and server scope checks are the authorization boundary. The manifest and these instructions do not enforce read-only access. Have the user verify the selected team/permissions in the consent screen; use the host's tool inventory to confirm only the expected tools are available. For `domains:read` expect `list_domains` and `get_domain`; `emails:read` additionally exposes `list_emails`, `get_email`, `get_email_insights`, `get_deliverability`, `get_usage`. If write/secret tools or `list_teams` are present, stop and ask for a restricted reconnection. Do not invoke any tool until this check passes.
5. Once linked, perform only the specific requested read using the inspect-delivery workflow. Do not use `get_usage` to promote plans or initiate purchases. Missing tools, failed authorization or missing data are limitations to report, not reasons to invent results or broaden access.

Use the exact redirect URI shown by the host when a human configures a connection; never guess a client ID or callback. A 401 challenge/discovery response is not a successful OAuth login. Do not say DNS is verified, email delivered or credentials revoked without the relevant real result. Stop on 401/403 and use the host's reauthorization flow; respect rate-limit retry hints without repeated polling.

No write or send is supported by this package, even when a user confirms in chat or a broad grant exists. Future write support requires separate server-side scope enforcement, explicit confirmation bound to the actual operation, and independent review. Never bypass suppression, unsubscribe, tenant boundaries or host safeguards.
