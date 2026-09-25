"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  siDotnet,
  siElixir,
  siGo,
  siNodedotjs,
  siOpenjdk,
  siPhp,
  siPython,
  siRuby,
  siRust,
} from "simple-icons";
import { CodeHighlight, type HighlightLanguage } from "@/components/code-highlight";
import { Drawer } from "@/components/drawer";
import { CodeGlyph } from "@/components/icons/nav-icons";

/* Snippets per language — the OFFICIAL Resend SDK, pointed at the MepMail
   API through its own base-URL option, plus the three calls people reach for
   from the Emails surface. Nothing here is our own client: `resend` is the
   published package, installed from the registry, and every method name below
   was checked against that package's source. Java is the exception — the
   official SDK hardcodes api.resend.com and offers no override, so its tab
   shows the plain HTTP call. */

/* The nine languages the sheets offer. Java is included even though the
   official Resend SDK can't be pointed at another base URL: the tab shows the
   plain HTTP call instead, which is what that SDK would do anyway. */
export const LANGS = [
  "node",
  "python",
  "php",
  "ruby",
  "go",
  "rust",
  "java",
  "dotnet",
  "elixir",
] as const;

export type Lang = (typeof LANGS)[number];

export const LANG_META: Record<
  Lang,
  { label: string; hljs: HighlightLanguage; icon: { path: string } }
> = {
  node: { label: "Node.js", hljs: "javascript", icon: siNodedotjs },
  python: { label: "Python", hljs: "python", icon: siPython },
  php: { label: "PHP", hljs: "php", icon: siPhp },
  ruby: { label: "Ruby", hljs: "ruby", icon: siRuby },
  go: { label: "Go", hljs: "go", icon: siGo },
  rust: { label: "Rust", hljs: "rust", icon: siRust },
  // Java's own mark is trademark-restricted; OpenJDK is the ecosystem icon.
  java: { label: "Java", hljs: "java", icon: siOpenjdk },
  dotnet: { label: ".NET", hljs: "csharp", icon: siDotnet },
  elixir: { label: "Elixir", hljs: "elixir", icon: siElixir },
};

export function LangIcon({ path }: { path: string }) {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

interface Snippets {
  send: string;
  batch: string;
  retrieve: string;
}

const SNIPPETS: Record<Lang, Snippets> = {
  node: {
    send: `import { Resend } from "resend";

const resend = new Resend("ms_xxxxxxxxx", {
  baseUrl: "https://api-mepmail.agenciamep.com",
});

const { data, error } = await resend.emails.send({
  from: "Acme <onboarding@yourdomain.com>",
  to: ["delivered@example.com"],
  subject: "hello world",
  html: "<h1>it works!</h1>",
});`,
    batch: `const { data, error } = await resend.batch.send([
  {
    from: "Acme <onboarding@yourdomain.com>",
    to: ["delivered@example.com"],
    subject: "hello world",
    html: "<h1>it works!</h1>",
  },
  {
    from: "Acme <onboarding@yourdomain.com>",
    to: ["bounced@example.com"],
    subject: "world hello",
    html: "<p>it works!</p>",
  },
]);`,
    retrieve: `const { data, error } = await resend.emails.get(
  "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
);`,
  },
  python: {
    send: `import resend

resend.api_key = "ms_xxxxxxxxx"
resend.api_url = "https://api-mepmail.agenciamep.com"  # sem barra no final

email = resend.Emails.send({
    "from": "Acme <onboarding@yourdomain.com>",
    "to": ["delivered@example.com"],
    "subject": "hello world",
    "html": "<h1>it works!</h1>",
})`,
    batch: `emails = resend.Batch.send([
    {
        "from": "Acme <onboarding@yourdomain.com>",
        "to": ["delivered@example.com"],
        "subject": "hello world",
        "html": "<h1>it works!</h1>",
    },
    {
        "from": "Acme <onboarding@yourdomain.com>",
        "to": ["bounced@example.com"],
        "subject": "world hello",
        "html": "<p>it works!</p>",
    },
])`,
    retrieve: `email = resend.Emails.get(
    "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
)`,
  },
  php: {
    send: `putenv("RESEND_BASE_URL=https://api-mepmail.agenciamep.com");

$resend = Resend::client("ms_xxxxxxxxx");

$resend->emails->send([
    "from" => "Acme <onboarding@yourdomain.com>",
    "to" => "delivered@example.com",
    "subject" => "hello world",
    "html" => "<h1>it works!</h1>",
]);`,
    batch: `putenv("RESEND_BASE_URL=https://api-mepmail.agenciamep.com");

$resend = Resend::client("ms_xxxxxxxxx");

$resend->batch->send([
    [
        "from" => "Acme <onboarding@yourdomain.com>",
        "to" => "delivered@example.com",
        "subject" => "hello world",
        "html" => "<h1>it works!</h1>",
    ],
    [
        "from" => "Acme <onboarding@yourdomain.com>",
        "to" => "bounced@example.com",
        "subject" => "world hello",
        "html" => "<p>it works!</p>",
    ],
]);`,
    retrieve: `putenv("RESEND_BASE_URL=https://api-mepmail.agenciamep.com");

$resend = Resend::client("ms_xxxxxxxxx");

$email = $resend->emails->get("4ef9a417-02e9-4d39-ad75-9611e0fcc33c");`,
  },
  ruby: {
    send: `ENV["RESEND_BASE_URL"] = "https://api-mepmail.agenciamep.com/"  # barra final obrigatoria

require "resend"
Resend.api_key = "ms_xxxxxxxxx"

r = Resend::Emails.send({
  "from" => "Acme <onboarding@yourdomain.com>",
  "to" => ["delivered@example.com"],
  "subject" => "hello world",
  "html" => "<h1>it works!</h1>"
})`,
    batch: `ENV["RESEND_BASE_URL"] = "https://api-mepmail.agenciamep.com/"  # barra final obrigatoria

r = Resend::Batch.send([
  {
    "from" => "Acme <onboarding@yourdomain.com>",
    "to" => ["delivered@example.com"],
    "subject" => "hello world",
    "html" => "<h1>it works!</h1>"
  },
  {
    "from" => "Acme <onboarding@yourdomain.com>",
    "to" => ["bounced@example.com"],
    "subject" => "world hello",
    "html" => "<p>it works!</p>"
  }
])`,
    retrieve: `r = Resend::Emails.get("4ef9a417-02e9-4d39-ad75-9611e0fcc33c")`,
  },
  go: {
    send: `import (
	"net/url"

	"github.com/resend/resend-go/v4"
)

client := resend.NewClient("ms_xxxxxxxxx")
client.BaseURL, _ = url.Parse("https://api-mepmail.agenciamep.com/")  // barra final obrigatoria

sent, err := client.Emails.Send(&resend.SendEmailRequest{
	From:    "Acme <onboarding@yourdomain.com>",
	To:      []string{"delivered@example.com"},
	Subject: "hello world",
	Html:    "<h1>it works!</h1>",
})`,
    batch: `batch, err := client.Batch.Send([]*resend.SendEmailRequest{
	{
		From:    "Acme <onboarding@yourdomain.com>",
		To:      []string{"delivered@example.com"},
		Subject: "hello world",
		Html:    "<h1>it works!</h1>",
	},
	{
		From:    "Acme <onboarding@yourdomain.com>",
		To:      []string{"bounced@example.com"},
		Subject: "world hello",
		Html:    "<p>it works!</p>",
	},
})`,
    retrieve: `email, err := client.Emails.Get("4ef9a417-02e9-4d39-ad75-9611e0fcc33c")`,
  },
  rust: {
    send: `use resend_rs::types::CreateEmailBaseOptions;
use resend_rs::{Config, Resend};

let resend = Resend::with_config(
    Config::builder("ms_xxxxxxxxx")
        .base_url("https://api-mepmail.agenciamep.com".parse().context("failed to parse URL")?)
        .build(),
);

let email = resend
    .emails
    .send(
        CreateEmailBaseOptions::new(
            "Acme <onboarding@yourdomain.com>",
            ["delivered@example.com"],
            "hello world",
        )
        .with_html("<h1>it works!</h1>"),
    )
    .await?;`,
    batch: `let emails = resend
    .batch
    .send([
        CreateEmailBaseOptions::new(
            "Acme <onboarding@yourdomain.com>",
            ["delivered@example.com"],
            "hello world",
        )
        .with_html("<h1>it works!</h1>"),
        CreateEmailBaseOptions::new(
            "Acme <onboarding@yourdomain.com>",
            ["bounced@example.com"],
            "world hello",
        )
        .with_html("<p>it works!</p>"),
    ])
    .await?;`,
    retrieve: `let email = resend.emails.get("4ef9a417-02e9-4d39-ad75-9611e0fcc33c").await?;`,
  },
  java: {
    send: `// O SDK Java oficial fixa https://api.resend.com e nao aceita outra base,
// entao aqui vai a chamada HTTP direta na MepMail.
var body = """
    {
      "from": "Acme <onboarding@yourdomain.com>",
      "to": ["delivered@example.com"],
      "subject": "hello world",
      "html": "<h1>it works!</h1>"
    }
    """;

var request = HttpRequest.newBuilder()
    .uri(URI.create("https://api-mepmail.agenciamep.com/emails"))
    .header("Authorization", "Bearer ms_xxxxxxxxx")
    .header("Content-Type", "application/json")
    .POST(HttpRequest.BodyPublishers.ofString(body))
    .build();

var response = HttpClient.newHttpClient()
    .send(request, HttpResponse.BodyHandlers.ofString());`,
    batch: `var request = HttpRequest.newBuilder()
    .uri(URI.create("https://api-mepmail.agenciamep.com/emails/batch"))
    .header("Authorization", "Bearer ms_xxxxxxxxx")
    .header("Content-Type", "application/json")
    .POST(HttpRequest.BodyPublishers.ofString(body))
    .build();

var response = HttpClient.newHttpClient()
    .send(request, HttpResponse.BodyHandlers.ofString());`,
    retrieve: `var request = HttpRequest.newBuilder()
    .uri(URI.create("https://api-mepmail.agenciamep.com/emails/4ef9a417-02e9-4d39-ad75-9611e0fcc33c"))
    .header("Authorization", "Bearer ms_xxxxxxxxx")
    .GET()
    .build();

var response = HttpClient.newHttpClient()
    .send(request, HttpResponse.BodyHandlers.ofString());`,
  },
  dotnet: {
    send: `using Resend;

var options = new ResendClientOptions
{
    ApiToken = "ms_xxxxxxxxx",
    ApiUrl = "https://api-mepmail.agenciamep.com",
};

var resend = ResendClient.Create(options);

var message = new EmailMessage();
message.From = "Acme <onboarding@yourdomain.com>";
message.To.Add("delivered@example.com");
message.Subject = "hello world";
message.HtmlBody = "<h1>it works!</h1>";

await resend.EmailSendAsync(message);`,
    batch: `var messages = new List<EmailMessage>();

var first = new EmailMessage();
first.From = "Acme <onboarding@yourdomain.com>";
first.To.Add("delivered@example.com");
first.Subject = "hello world";
first.HtmlBody = "<h1>it works!</h1>";
messages.Add(first);

await resend.EmailBatchAsync(messages);`,
    retrieve: `var email = await resend.EmailRetrieveAsync(
    new Guid("4ef9a417-02e9-4d39-ad75-9611e0fcc33c"),
);`,
  },
  elixir: {
    send: `# pacote da comunidade: hex "resend" (elixir-saas/resend-elixir)
client = Resend.client(
  api_key: "ms_xxxxxxxxx",
  base_url: "https://api-mepmail.agenciamep.com"
)

{:ok, email} = Resend.Emails.send(client, %{
  from: "Acme <onboarding@yourdomain.com>",
  to: "delivered@example.com",
  subject: "hello world",
  html: "<h1>it works!</h1>"
})`,
    batch: `{:ok, emails} = Resend.Emails.send_batch(client, [
  %{
    from: "Acme <onboarding@yourdomain.com>",
    to: "delivered@example.com",
    subject: "hello world",
    html: "<h1>it works!</h1>"
  },
  %{
    from: "Acme <onboarding@yourdomain.com>",
    to: "bounced@example.com",
    subject: "world hello",
    html: "<p>it works!</p>"
  }
])`,
    retrieve: `{:ok, email} = Resend.Emails.get(
  client,
  "4ef9a417-02e9-4d39-ad75-9611e0fcc33c"
)`,
  },
};

/* Sheets for the non-email resources; `ns` is the message-namespace prefix
   carrying apiSheet.{title,<section>} keys. Every one of them carries
   copy-ready `curl` calls whose verb and path mirror apps/api exactly —
   /contacts, /segments, /topics, /broadcasts, /webhooks, /contact-properties,
   /domains, /api-keys. There are no per-language snippets here on purpose:
   the only client we could honestly document is the official Resend SDK, and
   the resource methods it exposes differ per language, so each one would have
   to be read out of that language's source before being published. The email
   sheet (SNIPPETS above) carries the language tabs, because there every
   language's send/batch/get was checked against its own package source. */
const API_BASE = "https://api-mepmail.agenciamep.com";
const AUTH = `-H "Authorization: Bearer ms_xxxxxxxxx"`;
const JSON_CT = `-H "Content-Type: application/json"`;
const SAMPLE_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";

export type ResourceSheet = {
  ns: string;
  sections: readonly string[];
  curl: Record<string, string>;
};

export const RESOURCE_SHEETS = {
  contacts: {
    ns: "audience.contacts",
    sections: ["list", "create", "update"],
    curl: {
      list: `curl "${API_BASE}/contacts" \\\n  ${AUTH}`,
      create: `curl -X POST "${API_BASE}/contacts" \\\n
  ${AUTH}
  ${JSON_CT} \\\n
  -d '{ "email": "ada@example.com", "first_name": "Ada", "last_name": "Lovelace" }'`,
      update: `curl -X PATCH "${API_BASE}/contacts/${SAMPLE_ID}" \\\n
  ${AUTH}
  ${JSON_CT} \\\n
  -d '{ "first_name": "Augusta" }'`,
    },
  },
  contactProperties: {
    ns: "audience.properties",
    sections: ["list", "create", "update"],
    curl: {
      list: `curl "${API_BASE}/contact-properties" \\\n  ${AUTH}`,
      create: `curl -X POST "${API_BASE}/contact-properties" \\
  ${AUTH} \\
  ${JSON_CT} \\
  -d '{ "key": "plan", "type": "string", "fallback_value": "free" }'`,
      update: `curl -X PATCH "${API_BASE}/contact-properties/${SAMPLE_ID}" \\
  ${AUTH} \\
  ${JSON_CT} \\
  -d '{ "fallback_value": "pro" }'`,
    },
  },
  segments: {
    ns: "audience.segments",
    sections: ["list", "create", "update"],
    curl: {
      list: `curl "${API_BASE}/segments" \\\n  ${AUTH}`,
      create: `curl -X POST "${API_BASE}/segments" \\\n
  ${AUTH}
  ${JSON_CT} \\\n
  -d '{ "name": "Power users" }'`,
      update: `curl -X PATCH "${API_BASE}/segments/${SAMPLE_ID}" \\\n
  ${AUTH}
  ${JSON_CT} \\\n
  -d '{ "name": "Paying users" }'`,
    },
  },
  topics: {
    ns: "audience.topics",
    sections: ["list", "create", "get"],
    curl: {
      list: `curl "${API_BASE}/topics" \\\n  ${AUTH}`,
      create: `curl -X POST "${API_BASE}/topics" \\\n
  ${AUTH}
  ${JSON_CT} \\\n
  -d '{ "name": "Product updates", "description": "New features", "default_subscription": "opt_in" }'`,
      get: `curl "${API_BASE}/topics/${SAMPLE_ID}" \\\n  ${AUTH}`,
    },
  },
  broadcasts: {
    ns: "broadcasts",
    sections: ["list", "create", "send"],
    curl: {
      list: `curl "${API_BASE}/broadcasts" \\\n  ${AUTH}`,
      create: `curl -X POST "${API_BASE}/broadcasts" \\\n
  ${AUTH}
  ${JSON_CT} \\\n
  -d '{ "segment_id": "6f1c8a2e-2f8b-4a1e-9c3d-7b5a0e4d2f11", "from": "Acme <news@yourdomain.com>", "subject": "October update", "html": "<h1>Fresh news</h1>" }'`,
      send: `curl -X POST "${API_BASE}/broadcasts/${SAMPLE_ID}/send" \\\n
  ${AUTH}`,
    },
  },
  domains: {
    ns: "domains",
    sections: ["list", "create", "verify"],
    curl: {
      list: `curl "${API_BASE}/domains" \\\n  ${AUTH}`,
      create: `curl -X POST "${API_BASE}/domains" \\
  ${AUTH} \\
  ${JSON_CT} \\
  -d '{ "name": "yourdomain.com" }'`,
      verify: `curl -X POST "${API_BASE}/domains/${SAMPLE_ID}/verify" \\\n  ${AUTH}`,
    },
  },
  apiKeys: {
    ns: "api-keys",
    sections: ["list", "create", "revoke"],
    curl: {
      list: `curl "${API_BASE}/api-keys" \\\n  ${AUTH}`,
      create: `curl -X POST "${API_BASE}/api-keys" \\
  ${AUTH} \\
  ${JSON_CT} \\
  -d '{ "name": "Production", "permission": "sending_access" }'`,
      revoke: `curl -X DELETE "${API_BASE}/api-keys/${SAMPLE_ID}" \\\n  ${AUTH}`,
    },
  },
  webhooks: {
    ns: "webhooks",
    sections: ["list", "create", "update"],
    curl: {
      list: `curl "${API_BASE}/webhooks" \\\n  ${AUTH}`,
      create: `curl -X POST "${API_BASE}/webhooks" \\\n
  ${AUTH}
  ${JSON_CT} \\\n
  -d '{ "endpoint": "https://example.com/hooks/mepmail", "events": ["email.delivered", "email.bounced"] }'`,
      update: `curl -X PATCH "${API_BASE}/webhooks/${SAMPLE_ID}" \\\n
  ${AUTH}
  ${JSON_CT} \\\n
  -d '{ "status": "disabled" }'`,
    },
  },
} satisfies Record<string, ResourceSheet>;

type Resource = keyof typeof RESOURCE_SHEETS;

/**
 * "</>" affordance for the non-email list surfaces: same drawer as
 * ApiDocsButton, with copy-ready curl calls for the resource's three main
 * operations. The key hint is shared with the emails sheet
 * (emails.apiSheet.keyHint).
 */
export function ResourceApiButton({ resource }: { resource: Resource }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const sheet: ResourceSheet = RESOURCE_SHEETS[resource];
  const title = t(`${sheet.ns}.apiSheet.title`);

  return (
    <>
      <button
        type="button"
        className="ms-btn ms-btn-icon"
        aria-label={title}
        onClick={() => setOpen(true)}
      >
        <CodeGlyph size={14} />
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title={title}>
        {sheet.sections.map((section) => (
          <SheetSection
            key={section}
            title={t(`${sheet.ns}.apiSheet.${section}`)}
            code={sheet.curl[section] ?? ""}
            language="bash"
          />
        ))}
        <p style={{ margin: "20px 0 0", fontSize: 12.5, color: "var(--ms-muted)" }}>
          {t("emails.apiSheet.keyHint")}
        </p>
      </Drawer>
    </>
  );
}

function LangTabs({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Lang;
  onChange: (lang: Lang) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="ms-scroll-x"
      style={{
        display: "flex",
        gap: 4,
        flexWrap: "nowrap",
        marginTop: 4,
        overflowX: "auto",
        paddingBottom: 4,
      }}
    >
      {LANGS.map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={key === value}
          className={key === value ? "ms-code-tab active" : "ms-code-tab"}
          onClick={() => onChange(key)}
        >
          <LangIcon path={LANG_META[key].icon.path} />
          {LANG_META[key].label}
        </button>
      ))}
    </div>
  );
}

function SheetSection({
  title,
  code,
  language,
}: {
  title: string;
  code: string;
  language: HighlightLanguage;
}) {
  return (
    <section style={{ marginTop: 22 }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--ms-bone)" }}>{title}</h3>
      <CodeBlock code={code} language={language} />
    </section>
  );
}

function CodeBlock({ code, language }: { code: string; language: HighlightLanguage }) {
  return (
    <pre
      className="ms-mono ms-hl"
      style={{
        margin: "10px 0 0",
        padding: "14px 16px",
        background: "var(--ms-inset)",
        border: "1px solid var(--ms-line)",
        borderRadius: 10,
        fontSize: 12,
        lineHeight: 1.65,
        color: "var(--ms-bone)",
        overflowX: "auto",
        // Shell one-liners run past the drawer; wrapping beats a scrollbar
        // there, while SDK code keeps its indentation intact.
        ...(language === "bash" ? { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } : {}),
      }}
    >
      <CodeHighlight code={code} language={language} />
    </pre>
  );
}

/**
 * "</>" affordance on the Emails surfaces: opens a drawer with copy-ready
 * send/batch/retrieve snippets for every official SDK, so the dashboard hands
 * developers straight to code (the Resend sheet, on our own packages).
 */
export function ApiDocsButton() {
  const t = useTranslations("emails");
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState<Lang>("node");
  const snippets = SNIPPETS[lang];

  return (
    <>
      <button
        type="button"
        className="ms-btn ms-btn-icon"
        aria-label={t("list.apiDocs")}
        onClick={() => setOpen(true)}
      >
        <CodeGlyph size={14} />
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title={t("apiSheet.title")}>
        <LangTabs label={t("apiSheet.title")} value={lang} onChange={setLang} />

        {(
          [
            ["send", snippets.send],
            ["batch", snippets.batch],
            ["retrieve", snippets.retrieve],
          ] as const
        ).map(([section, code]) => (
          <SheetSection
            key={section}
            title={t(`apiSheet.${section}`)}
            code={code}
            language={LANG_META[lang].hljs}
          />
        ))}

        <p style={{ margin: "20px 0 0", fontSize: 12.5, color: "var(--ms-muted)" }}>
          {t("apiSheet.keyHint")}
        </p>
      </Drawer>
    </>
  );
}
