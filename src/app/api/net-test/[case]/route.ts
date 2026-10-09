/**
 * SPECTER — network-pipeline self-test endpoints.
 *
 * Private, local-only fixtures used by the engine's built-in diagnostics
 * (public/uv/sw.js `runSelfTest`) to verify the relay transport end-to-end:
 *
 *   echo      POST/GET round-trip (method, body bytes, cookie header, query)
 *   redirect  302 → echo?via=redirect           (redirect following)
 *   pix.png   67-byte PNG                       (binary/image passthrough)
 *   media     4 KB Range-capable fake mp4       (206 partial content)
 *   bigfile   1–8 MB Range-capable blob         (cancel/resume + starvation drills)
 *   download  attachment headers + 2 KB         (download header fidelity)
 *   page      tiny HTML doc                     (Ultraviolet rewrite path)
 *
 * Nothing is logged or persisted — RAM-only, exactly like the rest of SPECTER.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const MEDIA_BYTES = Buffer.alloc(4096);
for (let i = 0; i < MEDIA_BYTES.length; i++) MEDIA_BYTES[i] = i % 251;
const DOWNLOAD_BYTES = Buffer.alloc(2048, 0x53);

function echoJson(req: NextRequest, body: string): NextResponse {
  const res = NextResponse.json({
    ok: true,
    method: req.method,
    bytes: body.length,
    body,
    cookie: req.headers.get("cookie") ?? null,
    via: req.nextUrl.searchParams.get("via"),
    ts: Date.now(),
  });
  if (req.nextUrl.searchParams.get("set") === "1") {
    res.headers.append("set-cookie", "specter_selftest=1; Path=/; SameSite=Lax");
  }
  return res;
}

function rangeResponse(req: NextRequest): NextResponse {
  const total = MEDIA_BYTES.length;
  const range = req.headers.get("range");
  if (!range) {
    return new NextResponse(new Uint8Array(MEDIA_BYTES), {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "accept-ranges": "bytes",
        "content-length": String(total),
        "cache-control": "no-store",
      },
    });
  }
  const m = /bytes=(\d+)-(\d*)/.exec(range);
  if (!m) {
    return new NextResponse(null, {
      status: 416,
      headers: { "content-range": `bytes */${total}` },
    });
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
  if (!Number.isFinite(start) || start > end || start >= total) {
    return new NextResponse(null, {
      status: 416,
      headers: { "content-range": `bytes */${total}` },
    });
  }
  const slice = MEDIA_BYTES.subarray(start, end + 1);
  return new NextResponse(new Uint8Array(slice), {
    status: 206,
    headers: {
      "content-type": "video/mp4",
      "content-range": `bytes ${start}-${end}/${total}`,
      "content-length": String(slice.length),
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    },
  });
}

/** Deterministic pseudo-random payload (no allocation randomness cost). */
function fillPattern(buf: Buffer) {
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + 17) % 251;
  return buf;
}

function bigFileResponse(req: NextRequest): NextResponse {
  const requested = Number(req.nextUrl.searchParams.get("bytes")) || 2_000_000;
  const total = Math.max(1024, Math.min(requested, 8_388_608));
  const range = req.headers.get("range");
  if (!range) {
    const buf = fillPattern(Buffer.alloc(total));
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "accept-ranges": "bytes",
        "content-length": String(total),
        "cache-control": "no-store",
      },
    });
  }
  const m = /bytes=(\d+)-(\d*)/.exec(range);
  if (!m) {
    return new NextResponse(null, {
      status: 416,
      headers: { "content-range": `bytes */${total}` },
    });
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
  if (!Number.isFinite(start) || start > end || start >= total) {
    return new NextResponse(null, {
      status: 416,
      headers: { "content-range": `bytes */${total}` },
    });
  }
  const len = end - start + 1;
  const slice = fillPattern(Buffer.alloc(len));
  // each byte still matches the full-file pattern so resumed slices align
  for (let i = 0; i < len; i++) slice[i] = ((start + i) * 31 + 17) % 251;
  return new NextResponse(new Uint8Array(slice), {
    status: 206,
    headers: {
      "content-type": "application/octet-stream",
      "content-range": `bytes ${start}-${end}/${total}`,
      "content-length": String(len),
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    },
  });
}

async function dispatch(req: NextRequest, seg: string): Promise<NextResponse> {
  switch (seg) {
    case "echo": {
      const body = req.method === "POST" ? await req.text() : "";
      return echoJson(req, body);
    }
    case "redirect":
      return NextResponse.redirect(
        new URL("/api/net-test/echo?via=redirect", req.nextUrl.origin),
        302
      );
    case "pix.png":
      return new NextResponse(new Uint8Array(PNG_1PX), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(PNG_1PX.length),
          "cache-control": "no-store",
        },
      });
    case "media":
      return rangeResponse(req);
    case "bigfile":
      return bigFileResponse(req);
    case "download":
      return new NextResponse(new Uint8Array(DOWNLOAD_BYTES), {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(DOWNLOAD_BYTES.length),
          "content-disposition": 'attachment; filename="specter-selftest.bin"',
          "cache-control": "no-store",
        },
      });
    case "page":
      return new NextResponse(
        `<!doctype html><html><head><title>SPECTER SELFTEST</title></head><body>` +
          `<a href="/next">link</a><script src="/app.js"></script>` +
          `<p>selftest page</p></body></html>`,
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        }
      );
    default:
      return NextResponse.json({ error: "unknown fixture" }, { status: 404 });
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ case: string }> }) {
  const { case: seg } = await ctx.params;
  return dispatch(req, seg);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ case: string }> }) {
  const { case: seg } = await ctx.params;
  if (seg !== "echo") {
    return NextResponse.json({ error: "POST only supported on echo" }, { status: 405 });
  }
  return dispatch(req, seg);
}
