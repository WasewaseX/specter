"use client";

import { Ghost, ShieldCheck, ShieldOff, SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useSpecter } from "@/store/specter";

export default function Header() {
  const sessionReady = useSpecter((s) => s.sessionReady);
  const sid = useSpecter((s) => s.sid);
  const safeSearch = useSpecter((s) => s.safeSearch);
  const setSafeSearch = useSpecter((s) => s.setSafeSearch);
  const setDrawerOpen = useSpecter((s) => s.setDrawerOpen);

  const shortSid = sid ? sid.slice(0, 6).toUpperCase() : null;

  return (
    <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-2 px-2 sm:px-4">
        {/* brand */}
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <div
            aria-hidden="true"
            className="flex h-8 w-8 flex-none items-center justify-center rounded-md border border-emerald-400/20 bg-emerald-400/10"
          >
            <Ghost className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="flex min-w-0 flex-col leading-none">
            <span className="text-sm font-semibold tracking-[0.25em] text-zinc-100">SPECTER</span>
            <span className="mt-1 hidden font-mono text-[9px] text-zinc-500 sm:block">
              ZERO-TRACE SEARCH
            </span>
          </div>
        </div>

        {/* status + controls */}
        <div className="flex flex-none items-center gap-1 sm:gap-2">
          <span
            role="status"
            aria-label={
              sessionReady
                ? "Encrypted channel active: AES-256-GCM"
                : "Encrypted channel offline"
            }
            className={`inline-flex h-9 items-center gap-1.5 rounded-md border px-1.5 font-mono text-[9px] sm:px-2 sm:text-[10px] ${
              sessionReady
                ? "border-emerald-400/20 bg-emerald-400/5 text-emerald-300"
                : "border-zinc-800 bg-zinc-900/60 text-zinc-500"
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 flex-none rounded-full ${
                sessionReady ? "animate-pulse bg-emerald-400" : "bg-zinc-600"
              }`}
            />
            AES-256-GCM
          </span>

          {shortSid ? (
            <span className="hidden h-9 items-center rounded-md border border-zinc-800 bg-zinc-900/60 px-2 font-mono text-[10px] text-zinc-400 sm:inline-flex">
              SID {shortSid}
            </span>
          ) : null}

          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-pressed={safeSearch}
            aria-label={
              safeSearch
                ? "Safe Search is on — select to disable"
                : "Safe Search is off — select to enable"
            }
            onClick={() => setSafeSearch(!safeSearch)}
            className="size-11 hover:bg-zinc-800/60"
          >
            {safeSearch ? (
              <ShieldCheck className="size-5 text-emerald-400" aria-hidden="true" />
            ) : (
              <ShieldOff className="size-5 text-zinc-500" aria-hidden="true" />
            )}
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Open privacy controls"
            onClick={() => setDrawerOpen(true)}
            className="size-11 text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
          >
            <SlidersHorizontal className="size-5" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </header>
  );
}
