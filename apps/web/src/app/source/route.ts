import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    // Arquivo fechado pelo pipeline; nenhum caminho fornecido pelo visitante.
    const source = await readFile(resolve(process.cwd(), "../../source.tar.gz"));
    return new Response(new Uint8Array(source), {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": 'attachment; filename="mepmail-source.tar.gz"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    // Ausência não pode redirecionar para outra revisão do código.
    return new Response("Corresponding source archive unavailable", { status: 503 });
  }
}
