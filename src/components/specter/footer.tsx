"use client";

import { Lock, PlayCircle, ShieldCheck, Zap } from "lucide-react";

import { useSpecter } from "@/store/specter";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Footer — fixed status bar with the live privacy dashboard:
 * trackers blocked, data saved, tabs open. All values RAM-only.
 */
export default function Footer() {
  const stats = useSpecter((s) => s.stats);
  const tabs = useSpecter((s) => s.tabs);

  return (
    <footer className="mt-auto shrink-0 border-t border-zinc-800/60 bg-zinc-950/95 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-1 font-mono text-[10px] text-zinc-500">
        <p className="flex items-center gap-1.5">
          <Lock className="h-3 w-3 text-emerald-400" aria-hidden="true" />
          <span className="hidden sm:inline">◈ SPECTER — zero logs · zero trackers · zero knowledge</span>
          <span className="sm:hidden">◈ SPECTER · ZERO LOGS</span>
        </p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span
            className="inline-flex items-center gap-1 text-emerald-300"
            title="Ad/tracker requests blocked by the engine firewall this session"
          >
            <ShieldCheck className="h-3 w-3" aria-hidden="true" />
            {stats.blocked} blocked
          </span>
          <span
            className="inline-flex items-center gap-1 text-emerald-300"
            title="Bandwidth saved by Data Saver image recompression this session"
          >
            <Zap className="h-3 w-3" aria-hidden="true" />
            {formatBytes(stats.bytesSaved)} saved
            {stats.imagesCompressed > 0 ? ` · ${stats.imagesCompressed} imgs` : ""}
            {stats.videosDeferred > 0 ? ` · ${stats.videosDeferred} vids deferred` : ""}
          </span>
          {stats.mediaBytes > 0 ? (
            <span
              className="inline-flex items-center gap-1 text-emerald-300"
              title="Video/audio bytes actually downloaded — Range streaming means this is only what you watched; replays and scrub-backs come from your device cache"
            >
              <PlayCircle className="h-3 w-3" aria-hidden="true" />
              {formatBytes(stats.mediaBytes)} video used
            </span>
          ) : null}
          <span className="hidden items-center gap-1 md:inline-flex">
            {tabs.length} tab{tabs.length === 1 ? "" : "s"}
          </span>
        </p>
      </div>
    </footer>
  );
}
