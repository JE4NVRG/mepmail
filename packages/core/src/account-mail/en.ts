import type { AccountMailEntry, AccountMailKind, MailPhraseKey } from "../account-mail.js";

export const en = {
  welcome: {
    subject: "Welcome to MepMail",
    body: [
      "Hi {name}, your account is ready.",
      "First add a sending domain and publish its DNS records; sends go out the moment it verifies.",
      "Then create an API key under API keys — it is shown once, and it is what the SDKs, SMTP and the MCP server send with.",
    ],
    button: "Add a domain",
    muted: ["Docs: {docsUrl}"],
  },
  password_changed: {
    subject: "Your MepMail password was changed",
    body: [
      "The password for {email} was just changed and every other session was signed out.",
      "If this was you, nothing to do. If it wasn't, reset it now — that signs out whoever did it — and review your API keys and connected apps.",
    ],
    button: "Reset password",
  },
  "mcp.connected": {
    subject: "{app} is connected to your MepMail account",
    body: [
      "You allowed {app} to act on {team} through the MepMail MCP server with these permissions: {scopes}.",
      "It can do there what you can do, in your name, until you revoke it.",
    ],
    button: "Review connected apps",
    muted: ["Didn't authorize this? Revoke it now."],
    extra: { allTeams: "all your teams" },
  },
  "api_key.created": {
    subject: "New API key in {team}: {name}",
    body: [
      '{actor} created the API key "{name}" ({prefix}…{last4}, {permission}{scope}) in {team}.',
      "Anyone holding it can send from the team's verified domains. Not expected? Revoke it under API keys.",
    ],
    button: "Open API keys",
    extra: {
      scope: ", limited to {domain}",
      full_access: "full access",
      sending_access: "sending access",
      apiKeyActor: "an API key",
      mcpActor: "an MCP client",
      systemActor: "MepMail",
    },
  },
  "webhook.secret_rotated": {
    subject: "Webhook secret rotated for {host}",
    body: ["{actor} rotated the signing secret of {url} in {team}.", "{deadline}"],
    button: "Open the endpoint",
    extra: {
      overlap:
        "The previous secret keeps verifying until {until}; switch the receiver before then or its deliveries start failing.",
      immediately:
        "The previous secret stopped verifying at once; deliveries fail until the receiver uses the new one.",
    },
  },
  "member.joined": {
    subject: "{name} joined {team}",
    body: [
      "{name} ({email}) accepted the invitation and is now {role} of {team}.",
      "Members send and read logs; admins also manage domains, keys and webhooks. Remove them under Settings → Team if that's wrong.",
    ],
    button: "Open team settings",
    extra: { member: "a member", admin: "an admin", owner: "an owner" },
  },
  "domain.verified": {
    subject: "{domain} is verified",
    body: [
      "The DNS records for {domain} check out and it can send from any address on it — API, SMTP and broadcasts.",
      "We keep re-checking the records and will tell you if one disappears.",
    ],
    button: "Open domain",
  },
  "domain.lost": {
    subject: "{domain} lost its verification",
    body: [
      "A required DNS record for {domain} (DKIM or MAIL FROM) no longer resolves, so sends from it are refused until it's back — API calls fail and scheduled broadcasts stop at send time.",
      "Restore the record at your DNS host; verification returns on its own at the next check or when you press Verify.",
    ],
    button: "Open domain",
  },
  "domain.lost.identity": {
    subject: "{domain} lost its verification",
    body: [
      "SES has given up on {domain}: its identity is gone, or its DKIM records stayed missing past the 72-hour window. Sends from it are refused; add the domain again to keep sending from it.",
    ],
    button: "Open domains",
  },
  "broadcast.sent": {
    subject: '"{name}" went out to {count} recipients',
    body: [
      '"{subject}" was handed to {count} contacts of {team}; suppressed and unsubscribed addresses were skipped.{failed}',
      "Opens, clicks and bounces appear on the broadcast page as they arrive.",
    ],
    button: "Open broadcast",
    extra: { failed: " {n} could not be sent." },
  },
  "broadcast.sending": {
    subject: '"{name}" is going out over {days} days',
    body: [
      "{first} of {count} emails went out in the first wave; the rest follows as capacity frees, the last about {finishesAt}.",
      "Sends above the platform's daily capacity are spread over the following days; {team}'s transactional email is not held behind them.",
    ],
    button: "Open broadcast",
    muted: [
      "You get this once per broadcast that takes more than one day. The finish time is an estimate and moves as other teams send.",
    ],
  },
  "broadcast.held_quota": {
    subject: '"{name}": {parked} of {count} recipients are waiting for the quota',
    body: [
      "{sent} emails went out; {parked} are parked because {team} reached its quota of {limit}.",
      "{release}",
    ],
    button: "Review your plan",
    extra: {
      releaseDaily:
        "They go out after the reset at {resetsAt} UTC, or within minutes of a higher plan.",
      releaseMonthly:
        "They go out when the period renews on {date}, as soon as overage is turned on in Billing, or within minutes of a higher plan.",
    },
  },
  "broadcast.held": {
    subject: '"{name}" is on hold',
    body: [
      'Sending from {region} is paused across the platform while bounce and complaint rates settle, so "{name}" waits instead of going out; transactional email keeps flowing.',
      "It resumes by itself — we re-check every 15 minutes — and you'll get the usual sent report when it's done.",
    ],
    button: "Open broadcast",
  },
  "billing.payment_failed": {
    subject: "Payment failed for {team}'s {plan} plan",
    body: [
      "We couldn't charge the card on file for {team}'s {plan} plan.",
      "{retry} Nothing changes yet: {team} keeps sending {cap}. If the invoice stays unpaid, Stripe cancels the subscription and {team} returns to Free ({freeCap} emails a day).",
    ],
    button: "Pay the invoice",
    muted: ["Or update the card from Billing: {billingUrl}"],
    extra: {
      retryOn: "Stripe retries on {date}.",
      noRetry: "Stripe is not retrying on its own.",
    },
  },
  "billing.plan_activated": {
    subject: "{team} is on {plan}",
    body: [
      "Your subscription is active: {team} now sends {cap}, and anything parked over the old cap is released within minutes.",
      "Receipts and invoices come from Stripe; the subscription is managed from Billing.",
    ],
    button: "Open billing",
  },
  "billing.plan_changed": {
    subject: "{team} moved from {old} to {new}",
    body: [
      "From now on {team} sends {cap}. On a lower cap, sends already accepted are unaffected; past the new cap, daily plans wait for the next UTC day and monthly plans either bill overage (when it is on) or refuse new API sends until the period renews.",
      "Proration shows on the next Stripe invoice.",
    ],
    button: "Open billing",
  },
  "billing.cancel_scheduled": {
    subject: "Your {plan} plan ends on {date}",
    body: [
      "{team} stays on {plan} until {date}; after that it returns to Free ({freeCap} emails a day).",
      "Changed your mind? Resume the plan from Billing before then and nothing changes.",
    ],
    button: "Open billing",
  },
  "billing.cancel_reminder": {
    subject: "Reminder: {team}'s {plan} plan ends on {date}",
    body: [
      "On {date} {team} returns to Free: {freeCap} emails a day, and anything over the cap waits for the next day.",
      "Resume the plan from Billing to keep sending {cap}.",
    ],
    button: "Open billing",
  },
  "billing.downgraded": {
    subject: "{team} is now on Free",
    body: [
      "The {plan} plan ended on {date}. From today {team} sends up to {freeCap} emails a day; anything over waits for the next UTC day, and broadcasts over the cap go out in parts.",
      "Verified domains, contacts and API keys are untouched. Pick a plan again from Billing whenever you need more.",
    ],
    button: "Open billing",
  },
  "team.broadcasts_paused": {
    subject: "Broadcasts paused for {team}",
    body: [
      "The instance operator paused broadcasts for {team}: {reason}",
      "Transactional email keeps flowing through the API and SMTP. Scheduled broadcasts wait, and new ones cannot be sent, until the operator resumes them. Reply to this email if you have questions.",
    ],
    button: "Open broadcasts",
    extra: {
      complaints: "the complaint rate passed 0.1% over the last 7 days.",
      report: "an abuse report was received.",
      manual: "see the note below.",
      note: "Note from the operator: {note}",
    },
  },
  "team.suspended": {
    subject: "{team} is suspended",
    body: [
      "The instance operator suspended {team}: {reason}",
      "Every send is refused and broadcasts are on hold. API keys, domains, contacts and history stay as they are, and a reinstated team sends again within a minute. Reply to this email to resolve it.",
    ],
    button: "Open dashboard",
    extra: {
      reputation:
        "its bounce or complaint rates threaten the sending reputation the platform shares.",
      non_payment: "an invoice stayed unpaid.",
      manual: "see the note below.",
      note: "Note from the operator: {note}",
    },
  },
  "team.reinstated": {
    subject: "{team} is reinstated",
    body: [
      "The instance operator reinstated {team}. Sends go out again, and held broadcasts resume on their own within 15 minutes.",
    ],
    button: "Open dashboard",
  },
  "monitor.alert": {
    subject: "Content monitor: {team} needs a look",
    body: [
      "The content monitor's risk for {team} reached {risk} ({tier} tier, {samples} samples judged in the last 7 days, {flagged} over the flag line). The model reads a sample of accepted mail; nothing was paused or held on its account.",
      "Open the review page to see the sampled verdicts, the content checks and the team's history, and decide. This notice repeats at most once a day per team while the risk stays over the line.",
    ],
    button: "Open review",
  },
  "monitor.broadcasts_paused": {
    subject: "Content monitor paused broadcasts for {team}",
    body: [
      "{team} is in the new tier, its monitor risk reached {risk} and a sampled message scored {score}. Under the pause policy its broadcasts are now on hold; transactional mail still flows.",
      "The team sees broadcasts as paused pending review. Open the review page to read the verdicts and resume, suspend or clear.",
    ],
    button: "Open review",
  },
  "monitor.degraded": {
    subject: "Content monitor: {rate} of samples went unjudged in the last hour",
    body: [
      "{unjudged} of {samples} samples drawn in the last hour came back unjudged ({provider} · {model}). Sending is unaffected: an unjudged sample changes no risk, opens no flag and holds no mail.",
      "Common causes are a throttled or unreachable provider, missing credentials, or a model that answers outside the rubric's format. The console's Health card charts the unjudged share.",
    ],
    button: "Open console",
    muted: [
      "Sent to the instance operator at most once every six hours while the share stays over 20%.",
    ],
  },
  "review.held": {
    subject: "Sending held for review: {team}",
    body: [
      "Mail from {team} is held before it reaches SES: {note}. Accepted mail is kept and nothing has gone out.",
      "Open the review page to release sending (the held mail drains within 15 minutes) or suspend the team (it never leaves).",
    ],
    button: "Open review",
  },
  "mailbox.capacity": {
    subject: "Mail receiving at {share} of its slots",
    body: [
      "The SES receiving rules hold {used} of {total} recipient slots ({rules} rules of 100). New mailboxes stop activating when they are full.",
      "Add receipt rules to the active rule set (SES allows up to 200, about 20,000 mailboxes) and list them in MAILBOX_RECEIVING_PROVISIONING_CONFIG, or move customers to receiving by domain. This notice repeats at most once a day while usage stays over 80%.",
    ],
    button: "Open console",
  },
  "mailbox.send_requested": {
    subject: "{agent} wants to send an email from {mailbox}",
    body: [
      "The agent {agent} saved a draft in {mailbox} and asked you to approve sending it. Its key does not carry the send permission, so nothing has gone out.",
      "Open the draft, check the recipients and the text, and send it if it is right. To decline, edit or delete the draft.",
    ],
    button: "Open Mail",
    muted: ["You get at most one of these every 10 minutes per mailbox."],
  },
  "mailbox.agent_key_expiring": {
    subject: "Agent key {label} expires on {date}",
    body: [
      "The key {label}, which gives access to {mailbox}, expires on {date}. After that the agent using it can no longer read, draft or send with it, and its calls are refused.",
      "To keep the agent working, create a new key in Mail → Settings → Agents and swap it into the agent's MCP client. If it no longer needs access, do nothing: the key lapses on its own.",
    ],
    button: "Open Mail agents",
    muted: ["You get this notice once per key, about 7 days before it expires."],
  },
  "content.access_notice": {
    subject: "An operator read content in {team}",
    body: [
      "On {when}, an authorised operator of this instance read the subject and rendered text of {emails} in {team}, for a recorded security reason: {reason}.",
      "Recipient addresses, attachments, message headers and the raw HTML were withheld, and the access closed after 30 minutes. It is recorded in this team's audit log with the same date, and in the instance's own log since it happened.",
      "This notice is required of us within seven days of such an access and is sent whether or not anything came of it. Reply to this email if you want to know more.",
    ],
    button: "Open audit log",
    extra: {
      one: "one message",
      many: "{n} messages",
      phishing_or_malware: "suspected phishing or malware",
      complaint_spike: "a spike in spam complaints",
      provider_report: "an abuse report from a mailbox provider",
      legal_request: "a legal request",
      owner_support_request: "a support request from this team",
    },
  },
  "support.view_started": {
    subject: "Support view of {team} started",
    body: [
      "{operator}, an instance operator, opened the {team} dashboard in a read-only support view {reason}. It ends at {until}, or sooner if you end it.",
      "The content of sent emails, exports and secrets are not visible in that view. Every procedure the operator reads is counted, and the session is already in your team's audit log under Settings → Audit log. Open Support access under Settings to end it.",
    ],
    button: "Open support access",
    extra: {
      support_ticket: "at your request, support ticket {reference}",
      billing_dispute: "for a billing dispute, reference {reference}",
      other: "for another reason{reference}",
      ref: " (reference {reference})",
    },
  },
  "activation.add_domain": {
    subject: "Just your domain left to start sending with MepMail",
    body: [
      "Your team {team} is ready. To send email to any address, add the domain your messages come from, such as yourcompany.com.",
      "It takes three DNS records. The page shows exactly what to copy into your DNS provider (Cloudflare, GoDaddy, Namecheap and others) and checks on its own until they show up, usually within five minutes.",
    ],
    button: "Add a domain",
    muted: ["Stuck on a step? Talk to us in the chat: {supportUrl}"],
  },
  "activation.finish_domain": {
    subject: "{domain} is not verified yet",
    body: [
      "The DNS records for {domain} have not shown up for the mail provider yet.",
      "Publish them at your DNS provider before {deadline}. After that the verification expires and the domain has to be added again.",
    ],
    button: "See the records",
    muted: [
      "Already published them? DNS can take a few minutes; the domain page checks again every 30 seconds.",
      "Questions? Chat with us: {supportUrl}",
    ],
  },
  "activation.help": {
    subject: "Need a hand getting started with MepMail?",
    body: [
      "Your team {team} has no verified domain yet, so sending is limited to the test message to your own address.",
      "If something got in the way (DNS, your provider, n8n, SMTP or the API), chat with us and we will sort it out together.",
    ],
    button: "Chat with support",
    muted: ["Rather do it yourself? The step-by-step guide is at {docsUrl}"],
  },
  "mailbox.repriced": {
    subject: "{team}'s Mail moves to the price without a Send plan",
    body: [
      "Your team {team} no longer has a paid Send plan, which is what gives Mail mailboxes their discounted price.",
      "From the renewal on {date}, each mailbox costs {price}, the price of Mail without Send, with 10 GiB and 2,000 outbound deliveries a month. The period you already paid for does not change.",
      "If you would rather reduce mailboxes or cancel Mail, do it in Billing before the renewal.",
    ],
    button: "Open billing",
  },
  "mailbox.trial_ending": {
    subject: "{team}'s Mail free trial ends on {date}",
    body: [
      "The free trial of Mail for {team} ends on {date}. From then on, the card you added is charged for the plan you chose ({mailboxes} mailboxes), and the trial's sending limit no longer applies.",
      "To keep Mail, there is nothing to do. To stop before any charge, cancel Mail in Billing before {date}.",
    ],
    button: "Open billing",
    muted: ["You get this notice once, about 2 days before the trial ends."],
  },
  "mailbox.usage_near": {
    subject: "{team}: {title} at {share} of the {plan} plan",
    body: ["{detail}", "{upgradeLine}"],
    button: "See usage and plans",
    muted: ["You get this notice once per billing month for each limit of the plan."],
    extra: {
      title_outboundRecipients: "recipients sent",
      title_outboundBytes: "sent mail",
      title_inboundDeliveries: "messages received",
      title_inboundBytes: "received mail",
      title_storageBytes: "storage",
      outboundRecipients:
        "{team} has sent to {used} of the {limit} recipients included this billing month. At the limit, new sends are refused until the month renews on {date}.",
      outboundBytes:
        "{team} has sent {used} of the {limit} of mail included this billing month. At the limit, new sends are refused until the month renews on {date}.",
      inboundDeliveries:
        "{team} has received {used} of the {limit} messages included this billing month. A little past the limit, receiving pauses until the month renews on {date}, and senders get a bounce.",
      inboundBytes:
        "{team} has received {used} of the {limit} of mail included this billing month. A little past the limit, receiving pauses until the month renews on {date}, and senders get a bounce.",
      storageBytes:
        "{team}'s mailboxes use {used} of the {limit} of storage in the plan. When it is full, receiving pauses and new drafts are refused; stored mail stays readable.",
      upgrade:
        "To get more now, move to the {next} plan in Mail; the difference is charged at once.",
      largest: "Equipe is the largest plan. Write to suporte@mepmail.dev if your team needs more.",
    },
  },
  "mailbox.usage_reached": {
    subject: "{team}: {title} limit reached on the {plan} plan",
    body: ["{detail}", "{upgradeLine}"],
    button: "See usage and plans",
    muted: ["You get this notice once per billing month for each limit of the plan."],
    extra: {
      title_outboundRecipients: "recipients sent",
      title_outboundBytes: "sent mail",
      title_inboundDeliveries: "messages received",
      title_inboundBytes: "received mail",
      title_storageBytes: "storage",
      outboundRecipients:
        "{team} has sent to all {limit} recipients included this billing month. New sends are refused until the month renews on {date}.",
      outboundBytes:
        "{team} has sent all {limit} of mail included this billing month. New sends are refused until the month renews on {date}.",
      inboundDeliveries:
        "{team} has received the {limit} messages included this billing month ({used} so far). A little past the limit, receiving pauses until the month renews on {date}, and senders get a bounce.",
      inboundBytes:
        "{team} has received the {limit} of mail included this billing month ({used} so far). A little past the limit, receiving pauses until the month renews on {date}, and senders get a bounce.",
      storageBytes:
        "{team}'s mailboxes use all {limit} of storage in the plan. Receiving is paused and new drafts are refused; stored mail stays readable.",
      upgrade:
        "To get more now, move to the {next} plan in Mail; the difference is charged at once.",
      largest: "Equipe is the largest plan. Write to suporte@mepmail.dev if your team needs more.",
    },
  },
  "mailbox.receiving_paused": {
    subject: "{team}: Mail receiving is paused",
    body: [
      "Since {since}, mail sent to {team}'s addresses is returned to the sender (mailbox unavailable) and not stored, because {reason}.",
      "{resume} {upgradeLine}",
    ],
    button: "See usage and plans",
    muted: ["Mail received before the pause is kept and stays readable."],
    extra: {
      reason_inbound_deliveries:
        "the messages received this billing month passed the {plan} plan's limit",
      reason_inbound_bytes: "the mail received this billing month passed the {plan} plan's limit",
      reason_storage: "the {plan} plan's storage is full",
      resumePeriod: "Receiving starts again by itself when the billing month renews on {date}.",
      resumeStorage: "Receiving starts again by itself once storage is below the limit.",
      upgrade:
        "To receive again now, move to the {next} plan in Mail; the difference is charged at once.",
      largest: "Equipe is the largest plan. Write to suporte@mepmail.dev if your team needs more.",
    },
  },
} as const satisfies Record<AccountMailKind, AccountMailEntry>;

/** Sentences several kinds share, filled by the builders. */
export const enPhrases = {
  capUpToDay: "up to {n} emails a day",
  capUpToMonth: "up to {n} emails a month",
  capNone: "with no sending cap",
} as const satisfies Record<MailPhraseKey, string>;
