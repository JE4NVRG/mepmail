import "./agent-demo.css";

export interface AgentDemoLabels {
  label: string;
  description: string;
  inbox: string;
  sender: string;
  initials: string;
  isNew: string;
  subject: string;
  preview: string;
  otherSender: string;
  otherSubject: string;
  agent: string;
  read: string;
  reply: string;
  awaiting: string;
  approve: string;
  sent: string;
  foot: string;
}

/**
 * The hero's moving example: a message arrives, the agent drafts the answer,
 * the draft waits for the owner's approval and goes out. Pure CSS on a fixed
 * loop; with reduced motion the scene rests on its final, readable state. The
 * moving part is decorative (aria-hidden); the description says the same.
 * `compact` is the home's smaller version: one message in the inbox, tighter.
 */
export function AgentDemo({
  labels,
  compact = false,
}: {
  labels: AgentDemoLabels;
  compact?: boolean;
}) {
  const labelId = compact ? "correio-demo-label-home" : "correio-demo-label";
  return (
    <aside
      className={compact ? "correio-demo correio-demo-compact" : "correio-demo"}
      aria-labelledby={labelId}
    >
      <p className="correio-example-label" id={labelId}>
        {labels.label}
      </p>
      <p className="correio-demo-description">{labels.description}</p>
      <div className="correio-demo-stage" aria-hidden="true">
        <div className="correio-demo-pane">
          <div className="correio-demo-head">{labels.inbox}</div>
          <div className="correio-demo-row correio-demo-arrive">
            <span className="correio-demo-avatar">{labels.initials}</span>
            <div>
              <p className="correio-demo-from">
                {labels.sender} <span className="correio-demo-new">{labels.isNew}</span>
              </p>
              <p>{labels.subject}</p>
              <p className="correio-demo-muted">{labels.preview}</p>
            </div>
          </div>
          {compact ? null : (
            <div className="correio-demo-row correio-demo-quiet">
              <span className="correio-demo-avatar">··</span>
              <div>
                <p>{labels.otherSender}</p>
                <p className="correio-demo-muted">{labels.otherSubject}</p>
              </div>
            </div>
          )}
        </div>
        <div className="correio-demo-pane">
          <div className="correio-demo-head">{labels.agent}</div>
          <div className="correio-demo-work">
            <p className="correio-demo-muted correio-demo-read">{labels.read}</p>
            <div className="correio-demo-draft">
              <span className="correio-demo-dots">
                <span />
                <span />
                <span />
              </span>
              <span className="correio-demo-type">{labels.reply}</span>
            </div>
            <div className="correio-demo-wait">
              <span className="correio-demo-awaiting">{labels.awaiting}</span>
              <span className="correio-demo-approve">{labels.approve}</span>
            </div>
            <p className="correio-demo-sent">✓ {labels.sent}</p>
          </div>
        </div>
      </div>
      <p className="correio-note correio-example-foot">{labels.foot}</p>
    </aside>
  );
}
