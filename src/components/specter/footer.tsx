"use client";

import { Lock } from "lucide-react";

export default function Footer() {
  return (
    <footer className="mt-auto border-t border-zinc-800/60 px-4 py-4">
      <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-2 font-mono text-[11px] text-zinc-500 sm:flex-row">
        <p>◈ SPECTER — zero logs · zero trackers · zero knowledge</p>
        <p className="hidden items-center gap-1.5 sm:flex">
          <Lock className="h-3 w-3 text-emerald-400" aria-hidden="true" />
          AES-256-GCM SEALED TRANSPORT
        </p>
      </div>
    </footer>
  );
}
