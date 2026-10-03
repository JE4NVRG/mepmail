import { readFile } from "node:fs/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function correspondingSource(head: boolean): Promise<Response> {
  try {
    // Public files sealed into the image; the visitor supplies no filesystem path.
    const [source, revisionFile] = await Promise.all([
      readFile("/app/source.tar.gz"),
      readFile("/app/SOURCE-REVISION", "utf8"),
    ]);
    const revision = revisionFile.trim();
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid source revision");
    return new Response(head ? null : new Uint8Array(source), {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="mepmail-source-${revision.slice(0, 12)}.tar.gz"`,
        "Content-Length": String(source.byteLength),
        "X-MepMail-Revision": revision,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response(head ? null : "Corresponding source archive unavailable", {
      status: 503,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }
}

export async function GET(): Promise<Response> {
  return correspondingSource(false);
}

export async function HEAD(): Promise<Response> {
  return correspondingSource(true);
}
