"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { useTRPC } from "@/lib/trpc";
import { TemplateEditor } from "../editor";

/** Fit a full-width (560px) email into a card preview box. */
const PREVIEW_W = 560;
const PREVIEW_SCALE = 0.44;
const PREVIEW_H = 168;

/**
 * New-template entry point: pick a ready-made starter (rendered live in a
 * miniature iframe) or jump straight to the blank editor. Creating from a
 * starter copies its html/subject into the team's templates and lands in the
 * regular editor, where the content is already editable.
 */
export function StarterGallery() {
  const t = useTranslations("templates");
  const rawLocale = useLocale();
  const locale = rawLocale === "pt-BR" ? ("pt-BR" as const) : ("en" as const);
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [blank, setBlank] = useState(false);

  const query = useQuery(trpc.templates.starters.queryOptions({ locale }));
  const create = useMutation(
    trpc.templates.createFromStarter.mutationOptions({
      onSuccess: ({ id }) => {
        queryClient.invalidateQueries(trpc.templates.pathFilter());
        router.push(`/templates/${id}/edit`);
      },
    }),
  );

  if (blank) return <TemplateEditor />;

  const starters = query.data ?? [];

  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            <Crumb href="/templates" label={t("editor.back")} />
            <CrumbEnd label={t("starter.title")} />
          </>
        }
        title={t("starter.title")}
        subtitle={t("starter.subtitle")}
        actions={
          <button type="button" className="ms-btn ms-btn-secondary" onClick={() => setBlank(true)}>
            {t("starter.blank")}
          </button>
        }
      />

      {query.isPending ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill,minmax(248px,1fr))",
            gap: 16,
          }}
        >
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              style={{
                border: "1px solid var(--ms-line)",
                borderRadius: 10,
                overflow: "hidden",
                background: "var(--ms-panel)",
              }}
            >
              <Skeleton width="100%" height={PREVIEW_H} radius={0} />
              <div style={{ padding: "12px 14px 14px", display: "grid", gap: 8 }}>
                <Skeleton width={120} height="1lh" />
                <Skeleton width="90%" height="1lh" />
              </div>
            </div>
          ))}
        </div>
      ) : query.isError ? (
        <div
          style={{
            border: "1px solid var(--ms-line)",
            borderRadius: 10,
            padding: "18px 20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            background: "var(--ms-panel)",
            color: "var(--ms-muted)",
            fontSize: 14,
          }}
        >
          <span>{t("starter.loadError")}</span>
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            onClick={() => void query.refetch()}
          >
            {t("starter.retry")}
          </button>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill,minmax(248px,1fr))",
            gap: 16,
          }}
        >
          {starters.map((starter) => (
            <div
              key={starter.key}
              style={{
                border: "1px solid var(--ms-line)",
                borderRadius: 10,
                overflow: "hidden",
                background: "var(--ms-panel)",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div
                style={{
                  height: PREVIEW_H,
                  overflow: "hidden",
                  borderBottom: "1px solid var(--ms-line)",
                  background: "#f4f4f5",
                  position: "relative",
                }}
              >
                <iframe
                  title={starter.name}
                  srcDoc={starter.html}
                  tabIndex={-1}
                  aria-hidden="true"
                  sandbox=""
                  style={{
                    width: PREVIEW_W,
                    height: 900,
                    border: 0,
                    transform: `scale(${PREVIEW_SCALE})`,
                    transformOrigin: "top left",
                    pointerEvents: "none",
                  }}
                />
              </div>
              <div
                style={{
                  padding: "12px 14px 14px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  flex: 1,
                }}
              >
                <strong style={{ fontSize: 14, lineHeight: 1.3 }}>{starter.name}</strong>
                <p
                  style={{
                    margin: 0,
                    fontSize: 13,
                    color: "var(--ms-muted)",
                    lineHeight: 1.45,
                    flex: 1,
                  }}
                >
                  {starter.description}
                </p>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    marginTop: 4,
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--ms-faint)",
                      textTransform: "uppercase",
                      letterSpacing: 0.4,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t(`starter.categories.${starter.category}`)}
                  </span>
                  <button
                    type="button"
                    className="ms-btn ms-btn-secondary"
                    disabled={create.isPending}
                    onClick={() => create.mutate({ key: starter.key, locale })}
                  >
                    <BtnSpinner on={create.isPending && create.variables?.key === starter.key} />
                    {t("starter.use")}
                  </button>
                </div>
                {create.isError && create.variables?.key === starter.key ? (
                  <p style={{ margin: 0, fontSize: 12, color: "var(--ms-danger)" }}>
                    {t("starter.createError")}
                  </p>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
