import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The release this server runs; open pages compare it with their own (VersionNotice). */
export function GET() {
  return NextResponse.json(
    { revision: process.env.MILLIONSEND_REVISION ?? null },
    { headers: { "cache-control": "no-store" } },
  );
}
