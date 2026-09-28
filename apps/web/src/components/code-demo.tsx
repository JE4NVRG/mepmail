/**
 * The hero code sample: the official Resend SDK pointed at MepMail. Shared by
 * the landing hero and /alternatives/resend so the migration promise is shown
 * with the same snippet on both pages.
 */
export function CodeDemo({ subject, caption }: { subject: string; caption: string }) {
  return (
    <figure className="gtm-hero-demo">
      <div className="gtm-demo-window">
        <div className="gtm-demo-bar" aria-hidden="true">
          <span className="gtm-demo-dot" />
          <span className="gtm-demo-dot" />
          <span className="gtm-demo-dot" />
          <span className="gtm-demo-file">send.ts</span>
        </div>
        <pre className="gtm-demo-code">
          <code>
            <span className="gtm-k">import</span> {"{ Resend }"} <span className="gtm-k">from</span>{" "}
            <span className="gtm-s">&quot;resend&quot;</span>;{"\n\n"}
            <span className="gtm-k">const</span> resend = <span className="gtm-k">new</span> Resend(
            <span className="gtm-s">&quot;ms_…&quot;</span>, {"{"}
            {"\n  "}baseUrl:{" "}
            <span className="gtm-s">&quot;https://api-mepmail.je4ndev.com&quot;</span>,{"\n"}
            {"}"});{"\n\n"}
            <span className="gtm-k">await</span> resend.emails.send({"{"}
            {"\n  "}from: &quot;Acme &lt;onboarding@acme.dev&gt;&quot;,{"\n"}
            {"  "}to: <span className="gtm-s">&quot;delivered@example.com&quot;</span>,{"\n"}
            {"  "}subject: <span className="gtm-s">&quot;{subject}&quot;</span>,{"\n"}
            {"}"});{"\n"}
          </code>
        </pre>
        <div className="gtm-demo-response">
          <span className="gtm-demo-status">200 OK</span>
          <code>{'{ "id": "a1b2c3d4-…" }'}</code>
        </div>
      </div>
      <figcaption className="gtm-demo-caption">{caption}</figcaption>
    </figure>
  );
}
