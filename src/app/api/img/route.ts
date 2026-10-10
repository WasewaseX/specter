import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { upstreamFetch } from "@/lib/upstream-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/img?u=<encoded> — Data Saver image recompressor.
 *
 * The Ultraviolet service worker reroutes image requests here when Data
 * Saver is on. The image is fetched server-side, resized and recompressed
 * to WebP (quality 60, max 1280px) before a single byte reaches the user's
 * connection — typically a 5 MB photo arrives as ~80 KB. GIF/SVG/ICO pass
 * through untouched (animation / vector / tiny). No logs, RAM only.
 */

const MAX_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_WIDTH = 1280;
const QUALITY = 60;

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

const PASS_THROUGH = new Set([
  "image/gif", // animation would be lost
  "image/svg+xml", // already tiny, vector
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/avif", // already modern
  "image/webp", // already modern
]);

function headersFor(orig: number, web: number, cacheable: boolean): HeadersInit {
  return {
    "Content-Type": "image/webp",
    "X-Orig-Bytes": String(orig),
    "X-Web-Bytes": String(web),
    "Cache-Control": cacheable ? "private, max-age=3600" : "no-store",
    "Referrer-Policy": "no-referrer",
  };
}

/* ── output cache — RAM LRU, bounded (no persistence, Panic-safe) ──
 * Repeat views of the same public image must cost ZERO upstream fetches
 * and zero recompression. This matters most under upstream rate limits:
 * Wikimedia's Varnish answers 429 (retry-after: 600) after a few heavy
 * page loads from one IP, and the old behavior re-fetched EVERY image on
 * EVERY reload — a spiral that made Data Saver slower than no Data Saver.
 *   • successful outputs cached up to 3 MB each, 24 MB total, 10 min TTL;
 *   • upstream failures negative-cached briefly (429 honors retry-after,
 *     capped at 120 s) so a hurting host is not hammered while it hurts —
 *     the service worker's bare-relay rescue still fetches those live.
 * RAM only — images are public site assets fetched without credentials;
 * nothing here is user-personalised. */
interface ImgCacheEntry {
  status: number;
  contentType: string;
  buf: Buffer;
  headers: [string, string][];
  expires: number;
  size: number;
}
const IMG_CACHE = {
  map: new Map<string, ImgCacheEntry>(),
  order: [] as string[],
  bytes: 0,
  hits: 0,
};
const IMG_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const IMG_CACHE_MAX_ENTRY = 3 * 1024 * 1024;
const IMG_CACHE_MAX_ENTRIES = 400;
const IMG_CACHE_TTL = 10 * 60_000;
const IMG_NEG_TTL_DEFAULT = 45_000;
const IMG_NEG_TTL_MAX = 120_000;

function imgCacheEvict(key: string) {
  const ent = IMG_CACHE.map.get(key);
  if (!ent) return;
  IMG_CACHE.map.delete(key);
  const oi = IMG_CACHE.order.indexOf(key);
  if (oi !== -1) IMG_CACHE.order.splice(oi, 1);
  IMG_CACHE.bytes -= ent.size;
}

function imgCacheGet(key: string): ImgCacheEntry | null {
  const ent = IMG_CACHE.map.get(key);
  if (!ent) return null;
  if (Date.now() > ent.expires) {
    imgCacheEvict(key);
    return null;
  }
  const oi = IMG_CACHE.order.indexOf(key);
  if (oi !== -1 && oi !== IMG_CACHE.order.length - 1) {
    IMG_CACHE.order.splice(oi, 1);
    IMG_CACHE.order.push(key); // LRU touch
  }
  IMG_CACHE.hits++;
  return ent;
}

function imgCachePut(key: string, ent: ImgCacheEntry) {
  if (ent.size > IMG_CACHE_MAX_ENTRY) return;
  while (
    IMG_CACHE.order.length &&
    (IMG_CACHE.bytes + ent.size > IMG_CACHE_MAX_BYTES || IMG_CACHE.map.size >= IMG_CACHE_MAX_ENTRIES)
  ) {
    imgCacheEvict(IMG_CACHE.order[0]);
  }
  IMG_CACHE.map.set(key, ent);
  IMG_CACHE.order.push(key);
  IMG_CACHE.bytes += ent.size;
}

function negativeTtlFor(status: number, retryAfter: string | null): number {
  if (status === 429 && retryAfter) {
    const s = Number(retryAfter);
    if (Number.isFinite(s) && s > 0) return Math.min(IMG_NEG_TTL_MAX, Math.max(30_000, s * 1000));
  }
  return IMG_NEG_TTL_DEFAULT;
}

function imgResponse(ent: ImgCacheEntry): NextResponse {
  const headers: Record<string, string> = {};
  for (const [k, v] of ent.headers) headers[k] = v;
  headers["X-Specter-Img-Cache"] = "hit";
  return new NextResponse(new Uint8Array(ent.buf), {
    status: ent.status,
    headers,
  });
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

  const cacheKey = target.toString();
  const cached = imgCacheGet(cacheKey);
  if (cached) return imgResponse(cached);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const upstream = await upstreamFetch(target.toString(), {
      timeoutMs: FETCH_TIMEOUT_MS,
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });
    if (upstream.status >= 400) {
      // negative-cache so the rate-limited/missing asset is not re-hammered
      // on every reload while the SW rescue path serves the real bytes
      imgCachePut(cacheKey, {
        status: 502,
        contentType: "",
        buf: Buffer.alloc(0),
        headers: [["Cache-Control", "no-store"]],
        expires: Date.now() + negativeTtlFor(upstream.status, upstream.retryAfter ?? null),
        size: 0,
      });
      return new NextResponse(null, { status: 502 });
    }
    const buf = upstream.body;
    const contentType = upstream.contentType.split(";")[0].trim().toLowerCase();

    // unknown / non-image → passthrough so pages never lose assets
    if (contentType && !contentType.startsWith("image/")) {
      const headers: [string, string][] = [
        ["Content-Type", contentType],
        ["X-Orig-Bytes", String(buf.byteLength)],
        ["X-Web-Bytes", String(buf.byteLength)],
        ["Cache-Control", "private, max-age=3600"],
      ];
      imgCachePut(cacheKey, {
        status: 200,
        contentType,
        buf,
        headers,
        expires: Date.now() + IMG_CACHE_TTL,
        size: buf.byteLength,
      });
      return new NextResponse(new Uint8Array(buf), { status: 200, headers: Object.fromEntries(headers) });
    }

    if (buf.byteLength > MAX_BYTES) {
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: headersFor(buf.byteLength, buf.byteLength, true),
      });
    }

    // tiny images: recompressing costs latency and rarely shrinks them —
    // pass through untouched (keeps thumbnail-heavy sites like YouTube snappy)
    if (buf.byteLength <= 30_000) {
      const headers: [string, string][] = [
        ["Content-Type", contentType || "image/jpeg"],
        ["X-Orig-Bytes", String(buf.byteLength)],
        ["X-Web-Bytes", String(buf.byteLength)],
        ["Cache-Control", "private, max-age=3600"],
        ["Referrer-Policy", "no-referrer"],
      ];
      imgCachePut(cacheKey, {
        status: 200,
        contentType: contentType || "image/jpeg",
        buf,
        headers,
        expires: Date.now() + IMG_CACHE_TTL,
        size: buf.byteLength,
      });
      return new NextResponse(new Uint8Array(buf), { status: 200, headers: Object.fromEntries(headers) });
    }

    // already-efficient formats pass through untouched
    if (PASS_THROUGH.has(contentType)) {
      const headers: [string, string][] = [
        ["Content-Type", contentType],
        ["X-Orig-Bytes", String(buf.byteLength)],
        ["X-Web-Bytes", String(buf.byteLength)],
        ["Cache-Control", "private, max-age=3600"],
      ];
      imgCachePut(cacheKey, {
        status: 200,
        contentType,
        buf,
        headers,
        expires: Date.now() + IMG_CACHE_TTL,
        size: buf.byteLength,
      });
      return new NextResponse(new Uint8Array(buf), { status: 200, headers: Object.fromEntries(headers) });
    }

    const image = sharp(Buffer.from(buf), { animated: false }).rotate();
    const meta = await image.metadata();
    if (meta.width && meta.width > MAX_WIDTH) {
      image.resize({ width: MAX_WIDTH, withoutEnlargement: true });
    }
    const webp = await image.webp({ quality: QUALITY }).toBuffer();

    // safety: if compression somehow grew the payload, ship the original
    if (webp.byteLength >= buf.byteLength) {
      const headers: [string, string][] = [
        ["Content-Type", contentType || "image/jpeg"],
        ["X-Orig-Bytes", String(buf.byteLength)],
        ["X-Web-Bytes", String(buf.byteLength)],
        ["Cache-Control", "private, max-age=3600"],
      ];
      imgCachePut(cacheKey, {
        status: 200,
        contentType: contentType || "image/jpeg",
        buf,
        headers,
        expires: Date.now() + IMG_CACHE_TTL,
        size: buf.byteLength,
      });
      return new NextResponse(new Uint8Array(buf), { status: 200, headers: Object.fromEntries(headers) });
    }

    const outHeaders: [string, string][] = Object.entries(headersFor(buf.byteLength, webp.byteLength, true)) as [
      string,
      string,
    ][];
    imgCachePut(cacheKey, {
      status: 200,
      contentType: "image/webp",
      buf: webp,
      headers: outHeaders,
      expires: Date.now() + IMG_CACHE_TTL,
      size: webp.byteLength,
    });
    return new NextResponse(new Uint8Array(webp), { status: 200, headers: Object.fromEntries(outHeaders) });
  } catch {
    return new NextResponse(null, { status: 504 });
  } finally {
    clearTimeout(timer);
  }
}
