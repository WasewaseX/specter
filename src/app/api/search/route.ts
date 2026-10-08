import { NextRequest, NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";
import { open as openEnvelope, seal } from "@/lib/crypto";
import { getSession, rateLimit, touchSession } from "@/lib/session-store";
import { filterResults } from "@/lib/safe-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SearchRequest {
  query: string;
  safe: boolean;
  num?: number;
  recencyDays?: number;
}

interface SecureResult {
  id: number;
  title: string;
  url: string;
  snippet: string;
  host: string;
  date: string;
  rank: number;
}

/**
 * POST /api/search
 * Body: { sid, iv, data }  — data is AES-256-GCM sealed SearchRequest.
 * Response: { iv, data }   — sealed { results, tookMs, filteredCount, total }.
 *
 * The query never exists in plaintext form on the wire, and no query
 * text is ever written to disk or logs on the server.
 */
export async function POST(req: NextRequest) {
  const started = Date.now();
  let body: { sid?: string; iv?: string; data?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const session = getSession(body.sid);
  if (!session) {
    return NextResponse.json({ error: "no_session" }, { status: 401 });
  }

  const waitMs = rateLimit(session.id, 30, 60_000);
  if (waitMs > 0) {
    const envelope = await seal(session.key, {
      error: "rate_limited",
      retryInMs: waitMs,
    });
    return NextResponse.json(envelope, { status: 429 });
  }

  let request: SearchRequest;
  try {
    request = await openEnvelope<SearchRequest>(session.key, {
      iv: body.iv as string,
      data: body.data as string,
    });
  } catch {
    return NextResponse.json({ error: "decrypt_failed" }, { status: 400 });
  }

  const query = String(request.query ?? "").trim().slice(0, 400);
  if (!query) {
    const envelope = await seal(session.key, { results: [], total: 0, filteredCount: 0, tookMs: 0 });
    return NextResponse.json(envelope);
  }

  const safe = request.safe !== false;
  const num = Math.min(Math.max(Number(request.num) || 14, 1), 30);
  const recencyDays =
    Number.isFinite(request.recencyDays) && Number(request.recencyDays) > 0
      ? Math.min(Number(request.recencyDays), 365)
      : undefined;

  try {
    const zai = await ZAI.create();
    const raw = (await zai.functions.invoke("web_search", {
      query,
      num,
      ...(recencyDays ? { recency_days: recencyDays } : {}),
    })) as Array<{
      url?: string;
      name?: string;
      snippet?: string;
      host_name?: string;
      rank?: number;
      date?: string;
    }>;

    const all = (Array.isArray(raw) ? raw : []).filter((r) => r && typeof r.url === "string");

    const { results: safeFiltered, filteredCount } = filterResults(all, safe);

    const mapped = safeFiltered.map((r, i) => ({
      id: i + 1,
      title: String(r.name ?? "").slice(0, 300) || "(untitled result)",
      url: String(r.url ?? ""),
      snippet: String(r.snippet ?? "").slice(0, 600),
      host: String(r.host_name ?? "").slice(0, 200),
      date: String(r.date ?? ""),
      rank: Number(r.rank ?? i + 1),
    }));

    touchSession(session);

    const envelope = await seal(session.key, {
      results: mapped,
      total: all.length,
      filteredCount,
      tookMs: Date.now() - started,
    });
    return NextResponse.json(envelope, {
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  } catch (err) {
    const envelope = await seal(session.key, {
      error: "search_failed",
      message: err instanceof Error ? err.message : "unknown error",
      results: [],
      total: 0,
      filteredCount: 0,
      tookMs: Date.now() - started,
    });
    return NextResponse.json(envelope, { status: 502 });
  }
}
