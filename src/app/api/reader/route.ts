import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
import { upstreamFetch } from "@/lib/upstream-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/reader?u=<encoded> — Min-style Reader Mode.
 * Fetches the article server-side (so the client's network never sees the
 * host), extracts the main content with cheerio and returns clean JSON.
 * No logs, no cookies, RAM only.
 */

const MAX_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

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

interface ReaderPayload {
  title: string;
  host: string;
  paragraphs: string[];
  images: string[];
  wordCount: number;
}

function extract(html: string, baseUrl: string): ReaderPayload {
  const $ = cheerio.load(html);

  const title =
    $("article h1").first().text().trim() ||
    $("h1").first().text().trim() ||
    $("title").text().trim() ||
    "Untitled";

  // strip non-content
  $(
    "script, style, noscript, nav, header, footer, aside, form, iframe, svg, button, select, textarea, [role=banner], [role=navigation], [aria-hidden=true]"
  ).remove();

  // pick the densest container of <p> text
  const candidates = [
    "article",
    "[role=main]",
    "main",
    "#content",
    ".post-content",
    ".article-content",
    ".entry-content",
    "body",
  ];
  let root: cheerio.Cheerio<never> | null = null;
  let bestScore = 0;
  for (const sel of candidates) {
    const el = $(sel).first();
    if (!el.length) continue;
    const score = el.find("p").length * 2 + el.text().length / 2000;
    if (score > bestScore) {
      bestScore = score;
      root = el as unknown as cheerio.Cheerio<never>;
    }
  }
  if (!root) root = $("body") as unknown as cheerio.Cheerio<never>;

  const paragraphs: string[] = [];
  root
    .find("h2, h3, p, li, blockquote, pre")
    .toArray()
    .forEach((node) => {
      const tag = (node as { tagName?: string }).tagName?.toLowerCase() ?? "p";
      const text = $(node).text().replace(/\s+/g, " ").trim();
      if (!text || text.length < 2) return;
      if (tag === "h2" || tag === "h3") {
        paragraphs.push(`## ${text}`);
      } else if (tag === "li") {
        if (text.length > 24) paragraphs.push(`• ${text}`);
      } else if (text.length > 40 || tag === "pre") {
        paragraphs.push(text);
      }
      if (paragraphs.length >= 400) return;
    });

  const images: string[] = [];
  root
    .find("img[src]")
    .toArray()
    .slice(0, 12)
    .forEach((node) => {
      const src = $(node).attr("src") ?? "";
      try {
        if (/^(data|blob):/i.test(src)) return;
        const abs = new URL(src, baseUrl).toString();
        if (!/^https?:/i.test(abs)) return;
        if (!images.includes(abs)) images.push(abs);
      } catch {
        /* skip broken urls */
      }
    });

  const wordCount = paragraphs.join(" ").split(/\s+/).filter(Boolean).length;
  const host = (() => {
    try {
      return new URL(baseUrl).host;
    } catch {
      return "";
    }
  })();

  return { title, host, paragraphs, images, wordCount };
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("u");
  if (!raw) {
    return NextResponse.json({ error: "missing_url" }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return NextResponse.json({ error: "bad_url" }, { status: 400 });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return NextResponse.json({ error: "bad_protocol" }, { status: 400 });
  }
  if (isBlockedHost(target.hostname)) {
    return NextResponse.json({ error: "blocked_host" }, { status: 403 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const upstream = await upstreamFetch(target.toString(), {
      timeoutMs: FETCH_TIMEOUT_MS,
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (upstream.status >= 400) {
      return NextResponse.json({ error: "upstream_status", status: upstream.status }, { status: 502 });
    }
    if (upstream.body.byteLength > MAX_BYTES) {
      return NextResponse.json({ error: "too_large" }, { status: 413 });
    }
    const html = upstream.body.toString("utf-8");
    const payload = extract(html, upstream.finalUrl || target.toString());
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return NextResponse.json({ error: aborted ? "timeout" : "fetch_failed" }, { status: 504 });
  } finally {
    clearTimeout(timer);
  }
}
