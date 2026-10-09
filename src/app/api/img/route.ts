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
      return new NextResponse(null, { status: 502 });
    }
    const buf = upstream.body;
    const contentType = upstream.contentType.split(";")[0].trim().toLowerCase();

    // unknown / non-image → passthrough so pages never lose assets
    if (contentType && !contentType.startsWith("image/")) {
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "X-Orig-Bytes": String(buf.byteLength),
          "X-Web-Bytes": String(buf.byteLength),
          "Cache-Control": "private, max-age=3600",
        },
      });
    }

    if (buf.byteLength > MAX_BYTES) {
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: headersFor(buf.byteLength, buf.byteLength, true),
      });
    }

    // already-efficient formats pass through untouched
    if (PASS_THROUGH.has(contentType)) {
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "X-Orig-Bytes": String(buf.byteLength),
          "X-Web-Bytes": String(buf.byteLength),
          "Cache-Control": "private, max-age=3600",
        },
      });
    }

    const image = sharp(Buffer.from(buf), { animated: false }).rotate();
    const meta = await image.metadata();
    if (meta.width && meta.width > MAX_WIDTH) {
      image.resize({ width: MAX_WIDTH, withoutEnlargement: true });
    }
    const webp = await image.webp({ quality: QUALITY }).toBuffer();

    // safety: if compression somehow grew the payload, ship the original
    if (webp.byteLength >= buf.byteLength) {
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: {
          "Content-Type": contentType || "image/jpeg",
          "X-Orig-Bytes": String(buf.byteLength),
          "X-Web-Bytes": String(buf.byteLength),
          "Cache-Control": "private, max-age=3600",
        },
      });
    }

    return new NextResponse(new Uint8Array(webp), {
      status: 200,
      headers: headersFor(buf.byteLength, webp.byteLength, true),
    });
  } catch {
    return new NextResponse(null, { status: 504 });
  } finally {
    clearTimeout(timer);
  }
}
