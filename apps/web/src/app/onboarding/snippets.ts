import { LANG_META, LANGS } from "@/components/api-sheet";
import type { HighlightLanguage } from "@/components/code-highlight";
import { shellSingleQuote } from "@/lib/escape";

export const SNIPPET_LANGS = [...LANGS, "curl"] as const;
export type SnippetLang = (typeof SNIPPET_LANGS)[number];

export const SNIPPET_LABELS: Record<SnippetLang, string> = {
  ...Object.fromEntries(LANGS.map((l) => [l, LANG_META[l].label])),
  curl: "cURL",
} as Record<SnippetLang, string>;

export const SNIPPET_HLJS: Record<SnippetLang, HighlightLanguage> = {
  ...Object.fromEntries(LANGS.map((l) => [l, LANG_META[l].hljs])),
  curl: "bash",
} as Record<SnippetLang, HighlightLanguage>;

export interface SnippetParams {
  apiUrl: string;
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  /** Rides the key line: what the shown key is (masked, real on copy...). */
  comment?: string | undefined;
}

/* Double-quoted literal: JSON escaping is a valid string literal in every
   SDK language here, and the values are addresses and one-line copy. */
const q = JSON.stringify;
const slashNote = (c?: string) => (c ? ` // ${c}` : "");
const hashNote = (c?: string) => (c ? ` # ${c}` : "");

/**
 * The first-email call in each language, using the OFFICIAL Resend SDK pointed
 * at this account's own API URL. No client of ours appears here: `resend` is
 * the published package, and every method name was read out of that package's
 * own source (the same ones the emails API sheet shows).
 *
 * Java is the one exception - the official Java SDK hardcodes api.resend.com
 * and exposes no override, so that tab shows the plain HTTP call.
 *
 * Trailing slash is per-SDK, not cosmetic: Go and Ruby join the base with a
 * path that has no leading slash and need one; Python, Rust and Elixir append
 * "/emails" themselves and break with one. PHP and .NET don't care.
 */
export function onboardingSnippet(lang: SnippetLang, p: SnippetParams): string {
  switch (lang) {
    case "node":
      return `import { Resend } from "resend";

const resend = new Resend(${q(p.apiKey)}, { baseUrl: ${q(p.apiUrl)} });${slashNote(p.comment)}

await resend.emails.send({
  from: ${q(p.from)},
  to: [${q(p.to)}],
  subject: ${q(p.subject)},
  html: ${q(p.html)},
});`;
    case "python":
      return `import resend

resend.api_key = ${q(p.apiKey)}
resend.api_url = ${q(p.apiUrl)}${hashNote(p.comment)}

email = resend.Emails.send({
    "from": ${q(p.from)},
    "to": [${q(p.to)}],
    "subject": ${q(p.subject)},
    "html": ${q(p.html)},
})`;
    case "php":
      return `putenv(${q(`RESEND_BASE_URL=${p.apiUrl}`)});

$resend = Resend::client(${q(p.apiKey)});${slashNote(p.comment)}

$resend->emails->send([
    'from' => ${q(p.from)},
    'to' => ${q(p.to)},
    'subject' => ${q(p.subject)},
    'html' => ${q(p.html)},
]);`;
    case "ruby":
      return `ENV["RESEND_BASE_URL"] = ${q(`${p.apiUrl}/`)}  # trailing slash required

require "resend"
Resend.api_key = ${q(p.apiKey)}${hashNote(p.comment)}

r = Resend::Emails.send({
  "from" => ${q(p.from)},
  "to" => [${q(p.to)}],
  "subject" => ${q(p.subject)},
  "html" => ${q(p.html)}
})`;
    case "go":
      return `// github.com/resend/resend-go/v4
client := resend.NewClient(${q(p.apiKey)})${slashNote(p.comment)}
client.BaseURL, _ = url.Parse(${q(`${p.apiUrl}/`)})  // trailing slash required

sent, err := client.Emails.Send(&resend.SendEmailRequest{
    From:    ${q(p.from)},
    To:      []string{${q(p.to)}},
    Subject: ${q(p.subject)},
    Html:    ${q(p.html)},
})`;
    case "rust":
      return `use resend_rs::types::CreateEmailBaseOptions;
use resend_rs::{Config, Resend};

let resend = Resend::with_config(
    Config::builder(${q(p.apiKey)})${slashNote(p.comment)}
        .base_url(${q(p.apiUrl)}.parse()?)
        .build(),
);

let email = resend
    .emails
    .send(
        CreateEmailBaseOptions::new(${q(p.from)}, [${q(p.to)}], ${q(p.subject)})
            .with_html(${q(p.html)}),
    )
    .await?;`;
    case "java":
      return `// the official Java SDK hardcodes https://api.resend.com - call HTTP direct
var body = """
    {"from": ${q(p.from)}, "to": [${q(p.to)}], "subject": ${q(p.subject)}, "html": ${q(p.html)}}
    """;

var request = HttpRequest.newBuilder()
    .uri(URI.create(${q(`${p.apiUrl}/emails`)}))
    .header("Authorization", "Bearer " + ${q(p.apiKey)})${slashNote(p.comment)}
    .header("Content-Type", "application/json")
    .POST(HttpRequest.BodyPublishers.ofString(body))
    .build();`;
    case "dotnet":
      return `var options = new ResendClientOptions
{
    ApiToken = ${q(p.apiKey)},${slashNote(p.comment)}
    ApiUrl = ${q(p.apiUrl)},
};

var resend = ResendClient.Create(options);

await resend.EmailSendAsync(new EmailMessage
{
    From = ${q(p.from)},
    To = { ${q(p.to)} },
    Subject = ${q(p.subject)},
    HtmlBody = ${q(p.html)},
});`;
    case "elixir":
      return `# community package: hex "resend" (elixir-saas/resend-elixir)
client = Resend.client(
  api_key: ${q(p.apiKey)},${hashNote(p.comment)}
  base_url: ${q(p.apiUrl)}
)

{:ok, email} = Resend.Emails.send(client, %{
  from: ${q(p.from)},
  to: ${q(p.to)},
  subject: ${q(p.subject)},
  html: ${q(p.html)}
})`;
    case "curl": {
      const body = JSON.stringify({ from: p.from, to: p.to, subject: p.subject, html: p.html });
      // The comment takes its own line so any selection of the command
      // itself is valid shell - an inline comment after a trailing "\\"
      // breaks the continuation when copied.
      return `${p.comment ? `# ${p.comment}\n` : ""}curl -X POST ${p.apiUrl}/emails \\
  -H ${shellSingleQuote(`Authorization: Bearer ${p.apiKey}`)} \\
  -H 'Content-Type: application/json' \\
  -d ${shellSingleQuote(body)}`;
    }
  }
}
