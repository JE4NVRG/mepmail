import { getLocale, getTranslations } from "next-intl/server";
import { listStarters } from "@/server/starter-templates";
import { DeferredTemplatePreview } from "./deferred-template-preview";

/** These cards use the same library as the editor, rather than a screenshot. */
export async function PublicStarterGallery({ compact = false }: { compact?: boolean }) {
  const locale = await getLocale();
  const t = await getTranslations("landing.productProof");
  const templates = listStarters(locale);
  const featured = new Set(["welcome", "verify-email", "order-confirmation", "shipping-update"]);
  const shown = compact ? templates.filter((template) => featured.has(template.key)) : templates;
  const Heading = compact ? "h2" : "h3";
  return (
    <div className={compact ? "cro-starter-grid compact" : "cro-starter-grid"}>
      {shown.map((template) => (
        <article className="cro-starter-card" key={template.key}>
          <DeferredTemplatePreview
            templateKey={template.key}
            locale={locale}
            title={template.name}
          />
          <div className="cro-starter-copy">
            <Heading>{template.name}</Heading>
            {!compact && <p>{template.description}</p>}
            <a
              href={`/signup?next=${encodeURIComponent(`/templates/new?starter=${encodeURIComponent(template.key)}`)}`}
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
