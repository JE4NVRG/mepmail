import { readPublicStatus } from "@/lib/public-status";

export async function GET() {
  return Response.json(await readPublicStatus(), {
    headers: { "Cache-Control": "public, max-age=30, s-maxage=30" },
  });
}
