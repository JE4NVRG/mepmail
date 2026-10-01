import { getLocale, getTranslations } from "next-intl/server";
import { listStartersWithContent } from "@/server/starter-templates";

/** These cards use the same library as the editor, rather than a screenshot. */
export async function PublicStarterGallery({ compact = false }: { compact?: boolean }) {
  const locale = await getLocale();
  const t = await getTranslations("landing.productProof");
  const templates = listStartersWithContent(locale);
  const featured = new Set(["welcome", "verify-email", "order-confirmation", "shipping-update"]);
  const shown = compact ? templates.filter((template) => featured.has(template.key)) : templates;
  return (
    <div className={compact ? "cro-starter-grid compact" : "cro-starter-grid"}>
      {shown.map((template) => (
        <article className="cro-starter-card" key={template.key}>
          <div className="cro-starter-preview" aria-hidden="true">
            <iframe
              title={template.name}
              srcDoc={template.html}
              sandbox=""
              tabIndex={-1}
              loading={compact ? "eager" : "lazy"}
            />
          </div>
          <div className="cro-starter-copy">
            <h3>{template.name}</h3>
            {!compact && <p>{template.description}</p>}
            <a
              href={`/templates/new?starter=${encodeURIComponent(template.key)}`}
              aria-label={`${t("open")} · ${template.name}`}
            >
              {t("open")} <span aria-hidden="true">↗</span>
            </a>
          </div>
        </article>
      ))}
    </div>
  );
}
