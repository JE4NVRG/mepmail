import {
  assertMailboxSignatureEditor,
  MailboxRegistryError,
  setMailboxSignatureLogo,
} from "@millionsend/core";
import { z } from "zod";
import { appOrigin } from "@/lib/api-base-url";
import { isCrossOriginMutation } from "@/lib/http-url";
import { imagePixelSize, SIGNATURE_LOGO_MAX_BYTES, sniffImageType } from "@/lib/image-type";
import { recordAudit } from "@/server/audit";
import { mailboxActorAccessEnabled, mailboxRegistryEnabled } from "@/server/mailboxes";
import {
  deletePublicObject,
  keyFromPublicUrl,
  putPublicObject,
  uploadsEnabled,
} from "@/server/storage";
import { createContext } from "@/server/trpc";

export const runtime = "nodejs";

/**
 * Signature logo upload/removal for one Correio mailbox. Session-authenticated
 * (never an API key) for the active team; the caller must own the mailbox or
 * be a team admin, checked before anything reaches storage.
 *
 * One object per mailbox at `signature-logos/<teamId>/<mailboxId>.<ext>`,
 * overwritten on re-upload; the stored URL carries a ?v= cache-buster. Only
 * PNG and JPEG: every recipient's mail client must render it.
 */
type Context = Awaited<ReturnType<typeof createContext>>;
type Editor =
  | { status: 401 | 403 | 404 }
  | {
      ctx: Context & { session: NonNullable<Context["session"]>; teamId: string };
      actor: { teamId: string; userId: string };
    };

async function editor(request: Request, mailboxId: string): Promise<Editor> {
  const ctx = await createContext({ headers: request.headers });
  if (!ctx.session) return { status: 401 };
  if (!ctx.teamId || !ctx.role || ctx.supportView) return { status: 403 };
  const actor = { teamId: ctx.teamId, userId: ctx.session.user.id };
  if (!(await mailboxActorAccessEnabled(ctx.db, actor))) return { status: 404 };
  try {
    await assertMailboxSignatureEditor(ctx.db, actor, mailboxId);
  } catch (error) {
    if (error instanceof MailboxRegistryError)
      return { status: error.code === "not_found" ? 404 : 403 };
    throw error;
  }
  return { ctx: { ...ctx, session: ctx.session, teamId: ctx.teamId }, actor };
}

const mailboxIdSchema = z.uuid();

export async function POST(request: Request) {
  if (!uploadsEnabled() || !mailboxRegistryEnabled()) return new Response(null, { status: 404 });
  if (isCrossOriginMutation(request, appOrigin())) return new Response(null, { status: 403 });
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > SIGNATURE_LOGO_MAX_BYTES + 64 * 1024) return new Response(null, { status: 413 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response(null, { status: 400 });
  }
  const mailboxId = mailboxIdSchema.safeParse(form.get("mailboxId"));
  const file = form.get("file");
  if (!mailboxId.success || !(file instanceof File)) return new Response(null, { status: 400 });

  const auth = await editor(request, mailboxId.data);
  if (!("ctx" in auth)) return new Response(null, { status: auth.status });

  if (file.size > SIGNATURE_LOGO_MAX_BYTES) return new Response(null, { status: 413 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffImageType(bytes);
  if (type !== "png" && type !== "jpeg") return new Response(null, { status: 415 });
  const size = imagePixelSize(bytes, type);
  if (size && (size.width > 4096 || size.height > 4096)) return new Response(null, { status: 422 });

  const key = `signature-logos/${auth.actor.teamId}/${mailboxId.data}.${type}`;
  const objectUrl = await putPublicObject(key, bytes, `image/${type}`);
  const result = await setMailboxSignatureLogo(auth.ctx.db, auth.actor, {
    mailboxId: mailboxId.data,
    logoUrl: `${objectUrl}?v=${Date.now()}`,
    width: size?.width ?? null,
    height: size?.height ?? null,
  });
  const previousKey = result.previous ? keyFromPublicUrl(result.previous) : null;
  if (previousKey && previousKey !== key) await deletePublicObject(previousKey);
  await recordAudit(auth.ctx, {
    action: "mailbox.updated",
    target: { type: "mailbox", id: mailboxId.data },
    metadata: { signatureLogo: "uploaded" },
  });
  return Response.json({ signatureProfile: result.signatureProfile });
}

export async function DELETE(request: Request) {
  if (!uploadsEnabled() || !mailboxRegistryEnabled()) return new Response(null, { status: 404 });
  if (isCrossOriginMutation(request, appOrigin())) return new Response(null, { status: 403 });
  const mailboxId = mailboxIdSchema.safeParse(new URL(request.url).searchParams.get("mailboxId"));
  if (!mailboxId.success) return new Response(null, { status: 400 });

  const auth = await editor(request, mailboxId.data);
  if (!("ctx" in auth)) return new Response(null, { status: auth.status });

  const result = await setMailboxSignatureLogo(auth.ctx.db, auth.actor, {
    mailboxId: mailboxId.data,
    logoUrl: null,
  });
  const key = result.previous ? keyFromPublicUrl(result.previous) : null;
  if (key) await deletePublicObject(key);
  await recordAudit(auth.ctx, {
    action: "mailbox.updated",
    target: { type: "mailbox", id: mailboxId.data },
    metadata: { signatureLogo: "removed" },
  });
  return Response.json({ signatureProfile: result.signatureProfile });
}
