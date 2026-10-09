"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, File as FileIcon, Film, Music, FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSpecter, type MediaItem } from "@/store/specter";

/**
 * DownloaderPanel — built-in download manager (Min-style).
 * Lists media/file sources discovered on the active page (reported by the
 * injected page hook), lets the user download any URL through the relay,
 * and can save the current page itself. Everything streams via
 * /api/download — no buffering, zero data amplification.
 */

function downloadHref(u: string, name?: string): string {
  const params = new URLSearchParams({ u });
  if (name) params.set("name", name);
  return `/api/download?${params.toString()}`;
}

function labelFor(item: MediaItem): { name: string; host: string } {
  try {
    const url = new URL(item.u);
    const raw = url.pathname.split("/").filter(Boolean).pop() ?? url.host;
    let name = raw;
    try {
      name = decodeURIComponent(raw);
    } catch {
      /* keep raw */
    }
    return { name: name.slice(0, 60) || url.host, host: url.host };
  } catch {
    return { name: item.u.slice(0, 48), host: "" };
  }
}

function kindIcon(k: string) {
  if (k === "video") return Film;
  if (k === "audio") return Music;
  return FileIcon;
}

const KIND_LABEL: Record<string, string> = {
  video: "VIDEO",
  audio: "AUDIO",
  file: "FILE",
};

export default function DownloaderPanel({ onClose }: { onClose: () => void }) {
  const tabs = useSpecter((s) => s.tabs);
  const activeTabId = useSpecter((s) => s.activeTabId);
  const mediaByTab = useSpecter((s) => s.mediaByTab);
  const [manual, setManual] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const active = tabs.find((t) => t.id === activeTabId);
  const items = activeTabId ? mediaByTab[activeTabId] ?? [] : [];

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const normalizedManual = useMemo(() => {
    const t = manual.trim();
    if (!t) return null;
    if (/^https?:\/\//i.test(t)) return t;
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(t)) return `https://${t}`;
    return null;
  }, [manual]);

  function submitManual() {
    if (!normalizedManual) {
      setManualError("Not a valid URL");
      return;
    }
    setManualError(null);
    window.open(downloadHref(normalizedManual), "_blank", "noopener,noreferrer");
  }

  return (
    <>
      {/* click-away surface */}
      <button
        aria-label="Close downloader"
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default"
        tabIndex={-1}
      />
      <div
        role="dialog"
        aria-label="Downloader"
        className="absolute right-1.5 top-12 z-50 w-[calc(100vw-12px)] max-w-[360px] overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/97 shadow-2xl shadow-black/60 backdrop-blur md:right-2.5"
      >
        <div className="flex items-center justify-between border-b border-zinc-800/80 px-3.5 py-2.5">
          <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-emerald-300">
            <Download className="size-3" aria-hidden="true" />
            Downloader
            <span className="text-zinc-600">{items.length} found</span>
          </span>
          <span className="font-mono text-[9px] uppercase tracking-widest text-zinc-600">
            streamed · zero logs
          </span>
        </div>

        <div className="max-h-96 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
          {active?.url ? (
            <div className="flex items-center gap-2 border-b border-zinc-900 px-3 py-2.5">
              <FileText className="size-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] text-zinc-300">This page (HTML)</p>
                <p className="truncate font-mono text-[9px] text-zinc-600">{active.url}</p>
              </div>
              <a
                href={downloadHref(active.url, "page.html")}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Download current page HTML"
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-emerald-400/10 hover:text-emerald-300"
              >
                <Download className="size-3.5" aria-hidden="true" />
              </a>
            </div>
          ) : null}

          {items.map((item) => {
            const Icon = kindIcon(item.k);
            const { name, host } = labelFor(item);
            return (
              <div
                key={item.u}
                className="flex items-center gap-2 border-b border-zinc-900/70 px-3 py-2.5 last:border-b-0"
              >
                <Icon className="size-3.5 shrink-0 text-emerald-400/80" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] text-zinc-200" title={item.u}>
                    {name}
                  </p>
                  <p className="truncate font-mono text-[9px] uppercase tracking-wider text-zinc-600">
                    {KIND_LABEL[item.k] ?? "FILE"} · {host}
                  </p>
                </div>
                <a
                  href={downloadHref(item.u)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Download ${name}`}
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-emerald-400/10 hover:text-emerald-300"
                >
                  <Download className="size-3.5" aria-hidden="true" />
                </a>
              </div>
            );
          })}

          {items.length === 0 ? (
            <p className="px-3.5 py-6 text-center text-[11px] leading-relaxed text-zinc-600">
              No direct media found on this page yet. Play a video or scroll the page —
              sources appear here. MSE players (YouTube) stream in segments and can&apos;t
              be saved as one file.
            </p>
          ) : null}
        </div>

        {/* manual URL */}
        <div className="border-t border-zinc-800/80 px-3 py-2.5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitManual();
            }}
            className="flex items-center gap-1.5"
          >
            <Input
              ref={inputRef}
              value={manual}
              onChange={(e) => {
                setManual(e.target.value);
                setManualError(null);
              }}
              placeholder="Paste any file or video URL…"
              aria-label="Download a specific URL"
              autoComplete="off"
              spellCheck={false}
              className="h-8 border-zinc-800 bg-zinc-900/70 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-600"
            />
            <Button
              type="submit"
              size="sm"
              className="h-8 shrink-0 bg-emerald-400 px-2.5 text-zinc-950 hover:bg-emerald-300"
              aria-label="Download URL"
            >
              <Download className="size-3.5" aria-hidden="true" />
            </Button>
          </form>
          {manualError ? (
            <p role="alert" className="mt-1.5 font-mono text-[9px] text-red-400">
              {manualError}
            </p>
          ) : (
            <p className="mt-1.5 font-mono text-[9px] text-zinc-600">
              Streams through the relay — your IP never touches the file host.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
