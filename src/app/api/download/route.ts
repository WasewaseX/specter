import { NextRequest, NextResponse } from "next/server";
import { UA_HONEST, UA_BROWSER } from "@/lib/upstream-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/download?u=<encoded>&name=<optional> — built-in downloader.
 *
 * Streams the target file straight through the relay to the user with a
 * Content-Disposition: attachment header, so the browser saves it instead
 * of rendering it. The body is NEVER buffered — a 1 GB video costs exactly
 * its own bytes (zero amplification), and Range requests pass through, so
 * paused/resumed downloads continue where they stopped. No logs, RAM only.
 */

const HEADERS_TIMEOUT_MS = 30_000;

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^0\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /\.local$/i,
  /^metadata\./i,
];

function isBlockedHost(hostname: string): boolean {
  return BLOCKED_HOST_PATTERNS.some((p) => p.test(hostname));
}

function sanitizeFilename(input: string): string {
  const cleaned = input
    .replace(/[/\\?%*:|"'<>\x00-\x1f]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return cleaned || "download";
}

function filenameFromUrl(target: URL): string {
  try {
    const base = target.pathname.split("/").filter(Boolean).pop() ?? "";
    const decoded = decodeURIComponent(base);
    if (decoded) return sanitizeFilename(decoded);
  } catch {
    /* ignore */
  }
  return "download";
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("u");
  if (!raw) return new NextResponse(null, { status: 400 });

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return new NextResponse(null, { status: 400 });
  }
  if (isBlockedHost(target.hostname)) {
    return new NextResponse(null, { status: 403 });
  }

  const requestedName = req.nextUrl.searchParams.get("name");
  const filename = sanitizeFilename(requestedName ?? filenameFromUrl(target));
  const range = req.headers.get("range");

  // abort only while waiting for the upstream response headers — an active
  // download stream must never be cut off by a timer
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEADERS_TIMEOUT_MS);

  try {
    const attempt = async (ua: string) =>
      fetch(target.toString(), {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "User-Agent": ua,
          Accept: "*/*",
          ...(range ? { Range: range } : {}),
        },
        cache: "no-store",
      });

    // honest UA first (Cloudflare-friendly); browser UA on rejection
    let upstream = await attempt(UA_HONEST);
    if (upstream.status === 403 || upstream.status === 429) {
      const retry = await attempt(UA_BROWSER);
      if (retry.status !== 403 && retry.status !== 429) upstream = retry;
    }
    clearTimeout(timer);

    if (!upstream.ok && upstream.status !== 206) {
      return new NextResponse(null, { status: upstream.status });
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    if (!headers["accept-ranges"]) headers["accept-ranges"] = "bytes";

    return new NextResponse(upstream.body, {
      status: upstream.status === 206 ? 206 : 200,
      headers,
    });
  } catch {
    return new NextResponse(null, { status: 504 });
  }
}
