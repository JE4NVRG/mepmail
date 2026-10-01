import { randomUUID } from "node:crypto";
import { getDb, schema } from "@millionsend/db";
import { and, eq, isNull } from "drizzle-orm";
import { appOrigin } from "@/lib/api-base-url";
import { isCrossOriginMutation } from "@/lib/http-url";
import { sniffImageType, TEAM_LOGO_MAX_BYTES } from "@/lib/image-type";
import { getAuth } from "@/server/auth";
import {
  deletePublicObject,
  keyFromPublicUrl,
  putPublicObject,
  uploadsEnabled,
} from "@/server/storage";

/** The target is always the session user, never a client-supplied user/team ID. */
async function owner(request: Request) {
  if (isCrossOriginMutation(request, appOrigin())) return null;
  return getAuth().api.getSession({ headers: request.headers });
}

async function removeOwnedPhoto(url: string | null | undefined, userId: string) {
  const key = url ? keyFromPublicUrl(url) : null;
  if (key?.startsWith(`profile-photos/${userId}/`)) await deletePublicObject(key);
}

/** Read a bounded multipart body, including requests without Content-Length. */
async function photoFile(request: Request): Promise<File | 400 | 413> {
  const limit = TEAM_LOGO_MAX_BYTES + 64 * 1024;
  if (Number(request.headers.get("content-length")) > limit) return 413;
  const reader = request.body?.getReader();
  if (!reader) return 400;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return 413;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const form = await new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: bytes,
    }).formData();
    const file = form.get("file");
    return file instanceof File ? file : 400;
  } catch {
    return 400;
  }
}

export async function POST(request: Request) {
  if (!uploadsEnabled()) return new Response(null, { status: 404 });
  if (isCrossOriginMutation(request, appOrigin())) return new Response(null, { status: 403 });
  const session = await owner(request);
  if (!session) return new Response(null, { status: 401 });
  const file = await photoFile(request);
  if (typeof file === "number") return new Response(null, { status: file });
  if (!file.size || file.size > TEAM_LOGO_MAX_BYTES) return new Response(null, { status: 413 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffImageType(bytes);
  if (!type) return new Response(null, { status: 415 });
  const db = getDb();
  const [user] = await db
    .select({ image: schema.user.image })
    .from(schema.user)
    .where(eq(schema.user.id, session.user.id));
  if (!user) return new Response(null, { status: 401 });
  const key = `profile-photos/${session.user.id}/${randomUUID()}.${type}`;
  let image: string;
  try {
    image = await putPublicObject(key, bytes, `image/${type}`);
    const updated = await db
      .update(schema.user)
      .set({ image, updatedAt: new Date() })
      .where(
        and(
          eq(schema.user.id, session.user.id),
          user.image === null ? isNull(schema.user.image) : eq(schema.user.image, user.image),
        ),
      )
      .returning({ id: schema.user.id });
    if (!updated.length) {
      await deletePublicObject(key);
      // Another tab replaced/removed the image while the upload was in flight.
      return new Response(null, { status: 409 });
    }
  } catch (error) {
    await deletePublicObject(key);
    throw error;
  }
  await removeOwnedPhoto(user.image, session.user.id);
  return Response.json({ image });
}

export async function DELETE(request: Request) {
  if (isCrossOriginMutation(request, appOrigin())) return new Response(null, { status: 403 });
  const session = await owner(request);
  if (!session) return new Response(null, { status: 401 });
  const db = getDb();
  const [user] = await db
    .select({ image: schema.user.image })
    .from(schema.user)
    .where(eq(schema.user.id, session.user.id));
  if (!user) return new Response(null, { status: 401 });
  const updated = await db
    .update(schema.user)
    .set({ image: null, updatedAt: new Date() })
    .where(
      and(
        eq(schema.user.id, session.user.id),
        user.image === null ? isNull(schema.user.image) : eq(schema.user.image, user.image),
      ),
    )
    .returning({ id: schema.user.id });
  if (!updated.length) return new Response(null, { status: 409 });
  await removeOwnedPhoto(user.image, session.user.id);
  return Response.json({ ok: true });
}
