import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    // Arquivo fechado pelo pipeline; nenhum caminho fornecido pelo visitante.
    const [source, revisionFile] = await Promise.all([
      readFile(resolve(process.cwd(), "../../source.tar.gz")),
      readFile(resolve(process.cwd(), "../../SOURCE-REVISION"), "utf8"),
    ]);
    const revision = revisionFile.trim();
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid source revision");
    return new Response(new Uint8Array(source), {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="mepmail-source-${revision.slice(0, 12)}.tar.gz"`,
        "X-MepMail-Revision": revision,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    // Ausência não pode redirecionar para outra revisão do código.
    return new Response("Corresponding source archive unavailable", { status: 503 });
  }
}
