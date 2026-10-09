import { NextRequest, NextResponse } from "next/server";
import { createSessionFromKey, destroySession, ensureSweeper, getSession } from "@/lib/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/session
 * Body: { key: "<base64 AES-256 session key>" }
 * Body: { action: "verify", sid } — check liveness without creating anything.
 * Body: { action: "destroy", sid }
 * The key is generated in the browser and lives in server RAM only.
 * No cookies. No persistence. No logs.
 */
export async function POST(req: NextRequest) {
  ensureSweeper();
  let body: { key?: string; action?: string; sid?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  if (body.action === "destroy" && body.sid) {
    destroySession(body.sid);
    return NextResponse.json({ ok: true, destroyed: true });
  }

  if (body.action === "verify" && body.sid) {
    const alive = getSession(body.sid) !== null;
    return NextResponse.json({ ok: true, alive });
  }

  if (!body.key || typeof body.key !== "string" || body.key.length < 40 || body.key.length > 100) {
    return NextResponse.json({ error: "invalid_key" }, { status: 400 });
  }

  const session = await createSessionFromKey(body.key);
  if (!session) {
    return NextResponse.json({ error: "session_capacity" }, { status: 503 });
  }

  return NextResponse.json({
    ok: true,
    sid: session.id,
    cipher: "AES-256-GCM",
    ttlHours: 24,
  });
}
