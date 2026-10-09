"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, BookOpen, Ghost, Globe, Loader2, RefreshCw, ShieldAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import NewTabHero from "@/components/specter/new-tab-hero";
import ResultsView from "@/components/specter/results-view";
import { buildProxySrc } from "@/lib/secure-client";
import { uvHref } from "@/lib/uv-browser";
import { useSpecter } from "@/store/specter";

const UV_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-pointer-lock";

/**
 * GhostBrowser — the surface of the active tab.
 * newtab → start page · search → encrypted results · web → the full
 * Ultraviolet browser, with Min-style Reader Mode on demand.
 *
 * Engine failures are NEVER silent: while the engine boots the tab shows an
 * honest "starting engine" state; if the engine failed, the tab shows an
 * explicit offline screen with a Retry control, and the script-stripped
 * limited viewer is only ever used after the user consciously opts in —
 * never smuggled in as if it were the full browser.
 */
export default function GhostBrowser() {
  const tabs = useSpecter((s) => s.tabs);
  const activeTabId = useSpecter((s) => s.activeTabId);
  const uvStatus = useSpecter((s) => s.uvStatus);
  const uvAvailable = uvStatus === "ready";
  const relayFallbackAck = useSpecter((s) => s.relayFallbackAck);
  const readerOn = useSpecter((s) => s.readerOn);
  const key = useSpecter((s) => s.key);
  const sid = useSpecter((s) => s.sid);

  const active = tabs.find((t) => t.id === activeTabId);
  const webUrl = active?.kind === "web" ? active.url : null;
  const [fallbackState, setFallbackState] = useState<{ url: string | null; src: string | null }>({
    url: null,
    src: null,
  });

  // render-phase adjust: invalidate the fallback src whenever the URL changes
  if (fallbackState.url !== webUrl) {
    setFallbackState({ url: webUrl, src: null });
  }

  // hardened fallback src (encrypted relay, scripts stripped) — only built
  // once the user has explicitly chosen the limited viewer
  useEffect(() => {
    if (!webUrl || uvAvailable || !relayFallbackAck || !key || !sid) return;
    let cancelled = false;
    void buildProxySrc(key, sid, webUrl, false, false).then((src) => {
      if (!cancelled) setFallbackState({ url: webUrl, src });
    });
    return () => {
      cancelled = true;
    };
  }, [webUrl, uvAvailable, relayFallbackAck, key, sid]);

  const fallbackSrc = fallbackState.url === webUrl ? fallbackState.src : null;

  // SPA navigation inside the frame fires no load event — reconcile by polling
  const tabSync = useSpecter((s) => s.tabSync);
  useEffect(() => {
    if (!uvAvailable) return;
    const timer = setInterval(tabSync, 700);
    return () => clearInterval(timer);
  }, [uvAvailable, tabSync]);

  if (!active) return null;

  if (active.kind === "newtab") return <NewTabHero />;
  if (active.kind === "search") return <ResultsView />;

  // ── web tab ──────────────────────────────────────────────────
  if (readerOn && active.url) {
    return <ReaderView url={active.url} />;
  }

  // engine still negotiating — honest loading state, never a silent fallback
  if (uvStatus === "booting" && webUrl) {
    return (
      <div className="flex h-full items-center justify-center" aria-busy="true">
        <div className="flex flex-col items-center gap-3 text-zinc-500">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-400" aria-hidden="true" />
          <p className="font-mono text-[11px] uppercase tracking-widest">Starting browser engine…</p>
        </div>
      </div>
    );
  }

  // engine failed and the user has not opted into the limited viewer
  if (uvStatus === "failed" && !relayFallbackAck) {
    return <EngineOffline />;
  }

  const src = webUrl ? (uvAvailable ? uvHref(webUrl) : fallbackSrc) : null;

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      {active.loading ? (
        <div
          className="absolute left-0 top-0 z-10 h-0.5 w-full animate-pulse bg-emerald-400"
          aria-hidden="true"
        />
      ) : null}

      {/* explicit, honest banner — the limited viewer is NOT the full browser */}
      {!uvAvailable && relayFallbackAck ? (
        <div
          role="status"
          className="flex flex-none items-center gap-2 border-b border-amber-400/25 bg-amber-400/10 px-3 py-1.5"
        >
          <ShieldAlert className="h-3.5 w-3.5 flex-none text-amber-300" aria-hidden="true" />
          <p className="truncate font-mono text-[10px] uppercase tracking-widest text-amber-200">
            Limited viewer — scripts stripped (engine offline)
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void useSpecter.getState().retryEngine()}
            className="ml-auto h-7 flex-none px-2 font-mono text-[10px] uppercase tracking-widest text-amber-200 hover:bg-amber-400/10 hover:text-amber-100"
            aria-label="Retry the browser engine"
          >
            <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" />
            Retry engine
          </Button>
        </div>
      ) : null}

      {src ? (
        <iframe
          id="ghost-frame"
          key={`${active.id}#${active.nonce}#${uvAvailable ? "uv" : "relay"}`}
          src={src}
          title={`Ghost Browser — ${active.title}`}
          className="h-full w-full flex-1 bg-white"
          sandbox={uvAvailable ? UV_SANDBOX : "allow-same-origin"}
          onLoad={() => void useSpecter.getState().tabLoaded()}
        />
      ) : (
        <div className="flex h-full items-center justify-center" aria-busy="true">
          <div className="flex flex-col items-center gap-3 text-zinc-500">
            <Loader2 className="h-6 w-6 animate-spin text-emerald-400" aria-hidden="true" />
            <p className="font-mono text-[11px] uppercase tracking-widest">Sealing channel…</p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── engine failure screen (never silently looks like a loaded page) ── */

function EngineOffline() {
  const uvError = useSpecter((s) => s.uvError);
  const retryEngine = useSpecter((s) => s.retryEngine);
  const ackRelayFallback = useSpecter((s) => s.ackRelayFallback);
  const uvStatus = useSpecter((s) => s.uvStatus);
  const retrying = uvStatus === "booting";

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto px-4 py-10">
      <div className="w-full max-w-md rounded-xl border border-red-400/20 bg-red-400/5 p-6 text-center">
        <AlertTriangle className="mx-auto h-8 w-8 text-red-400" aria-hidden="true" />
        <h2 className="mt-4 font-mono text-xs uppercase tracking-[0.25em] text-red-300">
          Browser engine offline
        </h2>
        <p className="mt-3 break-words font-mono text-[11px] text-zinc-500" role="alert">
          {uvError ?? "unknown engine failure"}
        </p>
        <p className="mt-4 text-sm leading-6 text-zinc-400">
          Modern sites need the full engine (scripts, XHR, streaming). The alternative
          is a limited viewer with scripts stripped — plain pages render, apps will
          look broken. Nothing about this failure was logged.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <Button
            type="button"
            onClick={() => void retryEngine()}
            disabled={retrying}
            aria-label="Retry browser engine startup"
            className="bg-emerald-400 text-zinc-950 hover:bg-emerald-300"
          >
            {retrying ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            Retry browser engine
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={ackRelayFallback}
            className="text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
            aria-label="Continue in the limited script-stripped viewer"
          >
            <ShieldAlert className="mr-2 h-4 w-4" aria-hidden="true" />
            Continue in limited viewer
          </Button>
        </div>
        <p className="mt-4 font-mono text-[10px] uppercase tracking-widest text-zinc-600">
          relay usually recovers in seconds — retry fixes most failures
        </p>
      </div>
    </div>
  );
}

/* ── Reader Mode (Min feature) ──────────────────────────────── */

interface ReaderPayload {
  title: string;
  host: string;
  paragraphs: string[];
  images: string[];
  wordCount: number;
}

function ReaderView({ url }: { url: string }) {
  const toggleReader = useSpecter((s) => s.toggleReader);
  const dataSaver = useSpecter((s) => s.dataSaver);
  const [payload, setPayload] = useState<ReaderPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef<Map<string, ReaderPayload>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const cached = cache.current.get(url);
    if (cached) {
      setPayload(cached);
      setError(null);
      return;
    }
    setPayload(null);
    setError(null);
    fetch(`/api/reader?u=${encodeURIComponent(url)}`, { referrerPolicy: "no-referrer" })
      .then(async (res) => {
        const json = (await res.json()) as ReaderPayload & { error?: string };
        if (cancelled) return;
        if (!res.ok || json.error) {
          setError(json.error ?? "fetch_failed");
          return;
        }
        cache.current.set(url, json);
        setPayload(json);
      })
      .catch(() => {
        if (!cancelled) setError("network");
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div className="h-full min-h-0 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
      <div className="mx-auto w-full max-w-3xl px-5 py-8 sm:px-8">
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 rounded border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-emerald-300">
            <BookOpen className="h-3 w-3" aria-hidden="true" />
            Reader Mode
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.open(`/api/reader?u=${encodeURIComponent(url)}`, "_blank")}
              className="hidden font-mono text-[10px] text-zinc-500 hover:text-zinc-300 sm:inline-flex"
              aria-label="Open raw extracted text"
            >
              <Globe className="mr-1 h-3 w-3" aria-hidden="true" />
              RAW
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-zinc-500 hover:text-zinc-200"
              onClick={toggleReader}
              aria-label="Exit reader view"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>

        {error ? (
          <div className="mt-10 flex flex-col items-center rounded-lg border border-red-400/20 bg-red-400/5 px-6 py-10 text-center">
            <AlertTriangle className="h-8 w-8 text-red-400" aria-hidden="true" />
            <h2 className="mt-4 font-mono text-xs uppercase tracking-widest text-red-300">
              READER UNAVAILABLE
            </h2>
            <p className="mt-2 max-w-sm text-sm text-zinc-400">
              This page could not be extracted — it may be a login-only or app-style site.
              Exit Reader to load the full page through the browser engine.
            </p>
            <Button
              type="button"
              onClick={toggleReader}
              className="mt-6 border border-emerald-400/30 bg-transparent text-emerald-300 hover:bg-emerald-400/10 hover:text-emerald-200"
            >
              Load full page
            </Button>
          </div>
        ) : null}

        {!error && !payload ? (
          <div className="mt-8 space-y-4" aria-busy="true">
            <Skeleton className="h-8 w-3/4 bg-zinc-800/70" />
            <Skeleton className="h-3 w-1/4 bg-zinc-800/70" />
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-3 w-full bg-zinc-800/50" />
            ))}
          </div>
        ) : null}

        {payload ? (
          <article className="mt-6">
            <h1 className="text-2xl font-semibold leading-tight text-zinc-100 sm:text-3xl">
              {payload.title}
            </h1>
            <p className="mt-2 font-mono text-[11px] text-zinc-500">
              {payload.host} · {payload.wordCount} words · text-only extraction, zero scripts
            </p>

            {payload.images.length > 0 ? (
              <div className="mt-6 flex gap-3 overflow-x-auto pb-2 no-scrollbar" aria-label="Article images">
                {payload.images.slice(0, 8).map((img) => (
                  <img
                    key={img}
                    src={dataSaver ? `/api/img?u=${encodeURIComponent(img)}` : img}
                    alt=""
                    loading="lazy"
                    className="h-40 w-auto max-w-[70vw] flex-none rounded-lg border border-zinc-800 object-cover"
                  />
                ))}
              </div>
            ) : null}

            <div className="mt-6 space-y-4">
              {payload.paragraphs.map((para, i) =>
                para.startsWith("## ") ? (
                  <h2
                    key={i}
                    className="pt-4 text-lg font-semibold text-zinc-100"
                  >
                    {para.slice(3)}
                  </h2>
                ) : para.startsWith("• ") ? (
                  <p key={i} className="border-l-2 border-zinc-800 pl-4 text-sm text-zinc-400">
                    {para.slice(2)}
                  </p>
                ) : (
                  <p key={i} className="text-[15px] leading-7 text-zinc-300">
                    {para}
                  </p>
                )
              )}
              {payload.paragraphs.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-zinc-500">
                  <Ghost className="h-4 w-4" aria-hidden="true" />
                  No extractable text found on this page.
                </p>
              ) : null}
            </div>
          </article>
        ) : null}
      </div>
    </div>
  );
}
