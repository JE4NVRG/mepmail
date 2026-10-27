import { NextIntlClientProvider } from "next-intl";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import en from "../../../messages/en/mailboxes.json";
import pt from "../../../messages/pt-BR/mailboxes.json";
import { MailboxRail } from "../../../src/app/(dashboard)/mailboxes/mailbox-rail";
import type { MailboxFolder, MailboxKindFilter } from "../../../src/lib/mailbox-inbox-presentation";
import type { MailboxRailBox } from "../../../src/lib/mailbox-rail";
import "../../../src/styles/globals.css";

// Synthetic browser fixture for the real rail, React, catalogs and CSS.
// No auth, API/transport mocks or network credentials. Not a full product journey.
const query = new URLSearchParams(location.search);
const locale = query.get("locale") === "en" ? "en" : "pt-BR";
const count = Number(query.get("boxes") ?? 40);
const events: string[] = [];
const source: MailboxRailBox[] = Array.from({ length: count }, (_, i) => ({
  id: `box-${i}`,
  label: i === 39 ? "Suporte internacional" : `Caixa ${String(i).padStart(2, "0")}`,
  address: `mailbox-${i}@example.test`,
  kind: i % 3 === 0 ? "agent" : "person",
}));
(window as unknown as Record<string, unknown>).__correioFixture = { events, ready: false };
function Fixture() {
  const [folder, setFolder] = useState<MailboxFolder>(
    (query.get("folder") ?? "inbox") as MailboxFolder,
  );
  const [scope, setScope] = useState<MailboxKindFilter>("all");
  const [selectedId, setSelected] = useState<string | null>(query.get("selected"));
  const [expanded, setExpanded] = useState(false);
  return (
    <NextIntlClientProvider locale={locale} messages={{ mailboxes: locale === "en" ? en : pt }}>
      <div className="fixture-shell">
        <style>{`.fixture-shell{container-type:inline-size;display:flex;width:100%;height:100dvh}.fixture-reader{min-width:0;flex:1;padding:32px;color:var(--ms-muted)}.fixture-reader h1{color:var(--ms-bone)}#open-navigation{display:none}@media(max-width:620px){#open-navigation{display:inline-flex}.fixture-reader{padding:24px}}`}</style>
        <MailboxRail
          boxes={source}
          selectedId={selectedId}
          scope={scope}
          folder={folder}
          unread={{ "box-39": 3 }}
          inboxUnread={7}
          schedules={{ snoozed: 2, scheduled: 3, followUps: 4 }}
          expanded={expanded}
          onClose={() => {
            setExpanded(false);
            events.push("drawer:close");
          }}
          onSelectBox={(id) => {
            setSelected(id);
            events.push(`box:${id}`);
          }}
          onScope={(value) => {
            setScope(value);
            setSelected(null);
            events.push(`scope:${value}`);
          }}
          onFolder={(value) => {
            setFolder(value);
            setExpanded(false);
            events.push(`folder:${value}`);
          }}
          onPrefetch={(value) => events.push(`prefetch:${value}`)}
          dropProps={() => ({})}
          boxesMenu={[]}
          boxMenu={[]}
          folders={null}
          usage={null}
          onShortcuts={() => events.push("shortcuts")}
        />
        <main className="fixture-reader">
          <button
            type="button"
            id="open-navigation"
            className="ms-btn"
            onClick={() => setExpanded(true)}
          >
            Abrir caixas e pastas
          </button>
          <h1>Correio</h1>
          <p>Fixture com caixas sintéticas para testar a navegação real.</p>
          <p id="current-folder">{folder}</p>
          <p id="current-mailbox">{selectedId ?? scope}</p>
        </main>
      </div>
    </NextIntlClientProvider>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing isolated fixture root");
createRoot(root).render(<Fixture />);
setTimeout(() => {
  (window as unknown as Record<string, unknown>).__correioReady = true;
}, 100);
