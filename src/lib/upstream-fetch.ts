import http2 from "node:http2";
import zlib from "node:zlib";

/**
 * SPECTER — upstream fetch with HTTP/2 support.
 *
 * Several major hosts (all of Wikipedia/Wikimedia, Reddit) reject plain
 * HTTP/1.1 requests from cloud IPs with 403 — Node's global fetch only
 * speaks h1.1. This helper speaks HTTP/2 via node:http2 for those hosts
 * (with graceful fallback to regular fetch for everything else), so the
 * relay routes see the real page exactly like a desktop browser would.
 *
 * Server-side only. No logs, no persistence.
 */

export interface UpstreamResult {
  status: number;
  contentType: string;
  body: Buffer;
  finalUrl: string;
  /** Present on 429-style rate-limit responses (e.g. Wikimedia Varnish). */
  retryAfter?: string;
}

const H2_REQUIRED = [
  /(^|\.)wikipedia\.org$/i,
  /(^|\.)wikimedia\.org$/i,
  /(^|\.)wiktionary\.org$/i,
  /(^|\.)wikibooks\.org$/i,
  /(^|\.)wikiquote\.org$/i,
  /(^|\.)wikivoyage\.org$/i,
  /(^|\.)wikidata\.org$/i,
  /(^|\.)reddit\.com$/i,
  /(^|\.)redd\.it$/i,
];

const MAX_BYTES = 24 * 1024 * 1024;

/**
 * UA strategy: an honest relay UA passes Cloudflare (a spoofed Chrome UA on
 * Node's TLS fingerprint is a classic bot signal → 403 challenge). Sites
 * that reject unknown UAs get a second attempt with the browser string.
 */
export const UA_HONEST = "SpecterRelay/1.0 (private zero-log relay)";
export const UA_BROWSER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export function needsH2(hostname: string): boolean {
  return H2_REQUIRED.some((re) => re.test(hostname));
}

function decompress(body: Buffer, encoding: string | undefined): Buffer {
  if (!encoding) return body;
  try {
    const enc = encoding.toLowerCase().trim();
    if (enc === "gzip" || enc === "x-gzip") return zlib.gunzipSync(body);
    if (enc === "deflate") {
      // zlib.deflate vs raw deflate — try both
      try {
        return zlib.inflateSync(body);
      } catch {
        return zlib.inflateRawSync(body);
      }
    }
    if (enc === "br") return zlib.brotliDecompressSync(body);
  } catch {
    return body;
  }
  return body;
}

async function h2Fetch(
  target: URL,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<UpstreamResult> {
  return new Promise<UpstreamResult>((resolve, reject) => {
    const session = http2.connect(`https://${target.host}`);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        session.close();
      } catch {
        /* ignore */
      }
      fn();
    };

    const timer = setTimeout(() => {
      try {
        session.destroy(new Error("h2 timeout"));
      } catch {
        /* ignore */
      }
      finish(() => reject(new Error("h2_timeout")));
    }, timeoutMs);

    session.on("error", (err) => {
      finish(() => reject(err));
    });

    const h2headers: Record<string, string> = {
      [http2.constants.HTTP2_HEADER_METHOD]: "GET",
      [http2.constants.HTTP2_HEADER_PATH]: `${target.pathname}${target.search}`,
      ...Object.fromEntries(
        Object.entries(headers)
          .filter(([k]) => !/^host$/i.test(k) && !/^accept-encoding$/i.test(k))
          .map(([k, v]) => [k.toLowerCase(), v])
      ),
      "accept-encoding": "gzip, deflate, br",
    };

    const req = session.request(h2headers);
    let status = 0;
    let contentType = "application/octet-stream";
    let contentEncoding: string | undefined;
    let retryAfter: string | undefined;
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("response", (rh) => {
      status = Number(rh[":status"] ?? 0);
      contentType = String(rh["content-type"] ?? "application/octet-stream");
      contentEncoding = rh["content-encoding"] ? String(rh["content-encoding"]) : undefined;
      retryAfter = rh["retry-after"] ? String(rh["retry-after"]) : undefined;
    });

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BYTES) {
        req.close(http2.constants.NGHTTP2_CANCEL);
        return;
      }
      chunks.push(chunk);
    });

    req.on("error", (err) => {
      finish(() => reject(err));
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const body = decompress(raw, contentEncoding);
      finish(() => resolve({ status, contentType, body, finalUrl: target.toString(), retryAfter }));
    });

    req.end();
  });
}

async function attemptFetch(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<UpstreamResult> {
  const target = new URL(url);

  if (target.protocol === "https:" && needsH2(target.hostname)) {
    try {
      const result = await h2Fetch(target, headers, timeoutMs);
      // treat hard rejection as a signal to try h1.1 (e.g. h2 blocked upstream)
      if (result.status !== 0) return result;
    } catch {
      /* fall through to h1.1 */
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(target.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers,
      cache: "no-store",
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      body: buf,
      finalUrl: res.url || target.toString(),
      retryAfter: res.headers.get("retry-after") ?? undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function upstreamFetch(
  url: string,
  options?: {
    headers?: Record<string, string>;
    timeoutMs?: number;
  }
): Promise<UpstreamResult> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const base = options?.headers ?? {};
  const callerSetUa = Object.keys(base).some((k) => k.toLowerCase() === "user-agent");

  const attempts: Record<string, string>[] = callerSetUa
    ? [base]
    : [
        { ...base, "User-Agent": UA_HONEST },
        { ...base, "User-Agent": UA_BROWSER },
      ];

  let last: UpstreamResult | null = null;
  for (const headers of attempts) {
    const result = await attemptFetch(url, headers, timeoutMs);
    if (result.status !== 403) return result;
    last = result;
  }
  return last as UpstreamResult;
}
