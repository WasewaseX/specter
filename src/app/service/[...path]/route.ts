import { NextRequest, NextResponse } from "next/server";
import { UA_HONEST, UA_BROWSER } from "@/lib/upstream-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /service/<encoded> — server-side decoder + streamer for requests that
 * BYPASS the Ultraviolet service worker. By spec, <video>/<audio> element
 * fetches never touch service workers — they land here instead. The path is
 * UV's base64 codec: btoa(encodeURIComponent(realUrl)).
 *
 * This route decodes the target and streams it with full Range support, so
 * media elements download only the seconds actually watched. It also serves
 * as a graceful safety net for any other request the SW happens to miss.
 * No logs, RAM only.
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

/** Mirror of Ultraviolet.codec.plain (encodeURIComponent of the real URL). */
export function decodeServicePath(encoded: string): string | null {
  try {
    const url = decodeURIComponent(encoded);
    if (!/^https?:\/\//i.test(url)) return null;
    return url;
  } catch {
    return null;
  }
}

const PASS_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
];

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const encoded = (path ?? []).join("/");
  if (!encoded) return new NextResponse(null, { status: 400 });

  let real = decodeServicePath(encoded);
  if (!real) {
    // fall back to including the literal query string
    real = decodeServicePath(`${encoded}${req.nextUrl.search}`);
  }
  if (!real) return new NextResponse(null, { status: 400 });

  const range = req.headers.get("range");

  let target: URL;
  try {
    target = new URL(real);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  if (isBlockedHost(target.hostname)) {
    return new NextResponse(null, { status: 403 });
  }

  // Media elements (which bypass service workers by spec) get redirected to
  // the dedicated streaming route — proven reliable with the media stack,
  // with native Range pass-through so only watched seconds download.
  if (range) {
    return NextResponse.redirect(
      new URL(`/api/stream?u=${encodeURIComponent(target.toString())}`, req.nextUrl.origin),
      302
    );
  }

  // TEMP DIAGNOSTIC (dev console only, never persisted): who reaches the
  // server-side fallback for a request the SW was expected to guard? Media
  // destinations are excluded — <video>/<audio> bypass the SW by spec.
  {
    const dest = (req.headers.get("sec-fetch-dest") || "").toLowerCase();
    if (
      process.env.NODE_ENV !== "production" &&
      !["video", "audio", "media"].includes(dest)
    ) {
      console.log(
        `[service-fallback] ${req.method} ${target.host}${target.pathname.slice(0, 60)} referer=${req.headers.get("referer") ?? "-"} dest=${dest || "-"} mode=${req.headers.get("sec-fetch-mode") ?? "-"}`
      );
    }
  }

  // Ultraviolet splices the page-hook <script src="/uv/specter-client.js">
  // into HTML BEFORE URL-rewriting, so in some rewrite orders its src comes
  // back as a SITE-absolute URL (e.g. https://github.com/uv/specter-client.js).
  // The service worker guards those requests (sw.js) and serves our local
  // asset; when one slips past it to this server-side fallback, fetching it
  // "upstream" is nonsense (the path only exists on our origin) and 404s.
  // Serve the engine asset straight from our own /uv/ folder instead — same
  // bytes the SW would have returned. Same for the other engine scripts.
  const ENGINE_ASSET = /^\/uv\/(specter-client|uv\.client|uv\.handler|uv\.bundle|uv\.config|uv\.sw)\.(js|css)$/i;
  if (ENGINE_ASSET.test(target.pathname)) {
    return NextResponse.redirect(new URL(target.pathname, req.nextUrl.origin), 307);
  }

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

    let upstream = await attempt(UA_HONEST);
    if (upstream.status === 403) {
      const retry = await attempt(UA_BROWSER);
      if (retry.status !== 403) upstream = retry;
    }

    const headers: Record<string, string> = {
      "Cache-Control": "no-store",
      "Accept-Ranges": "bytes",
      "Referrer-Policy": "no-referrer",
    };
    for (const name of PASS_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }

    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers,
    });
  } catch {
    return new NextResponse(null, { status: 504 });
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  // non-media fallbacks (rare) — plain body passthrough
  return GET(req, ctx);
}
