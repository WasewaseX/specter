import { NextRequest, NextResponse } from "next/server";
import { UA_HONEST, UA_BROWSER } from "@/lib/upstream-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/stream?u=<encoded> — media streaming relay with native Range support.
 *
 * The Ultraviolet service worker routes <video>/<audio> element requests here.
 * The upstream Range header passes straight through, so the browser downloads
 * ONLY the seconds it actually watches — a "100 MB" video costs kilobytes
 * until you scrub/play through it. Responses are cacheable, so re-watching or
 * scrubbing back is served from the browser cache at zero extra cost — a
 * 100 MB video can therefore never cost more than ~100 MB of data (never
 * transcoded, never double-fetched). Bodies stream (no buffering) in both
 * directions. No logs, RAM only.
 */

const FETCH_TIMEOUT_MS = 30_000;

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

/** Upstream response headers worth forwarding to the media element. */
const PASS_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
];

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

  const range = req.headers.get("range");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
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
    if (upstream.status === 403) {
      const retry = await attempt(UA_BROWSER);
      if (retry.status !== 403) upstream = retry;
    }

    const headers: Record<string, string> = {
      "Accept-Ranges": "bytes",
      "Referrer-Policy": "no-referrer",
    };
    for (const name of PASS_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }

    /* Caching: media is content-addressed (signed URLs never change content),
     * so letting the browser cache range responses makes scrub-back and
     * replays free — watching a 100 MB video can never cost more than
     * ~100 MB. Only honour an upstream no-store when it is explicit. */
    const upstreamCache = upstream.headers.get("cache-control") ?? "";
    if (/no-store|no-cache/i.test(upstreamCache) && !/max-age/i.test(upstreamCache)) {
      headers["Cache-Control"] = "no-store";
    } else if (/max-age/i.test(upstreamCache)) {
      headers["Cache-Control"] = upstreamCache;
    } else {
      headers["Cache-Control"] = "private, max-age=1800";
    }

    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers,
    });
  } catch {
    return new NextResponse(null, { status: 504 });
  } finally {
    // keep the abort timer — it only fires if the client disconnects
    clearTimeout(timer);
  }
}
