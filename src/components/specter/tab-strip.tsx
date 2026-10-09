"use client";

import { Plus, X } from "lucide-react";

import { useSpecter } from "@/store/specter";

const DOT_STYLES = [
  "bg-emerald-400",
  "bg-teal-400",
  "bg-lime-400",
  "bg-green-400",
] as const;

function dotStyle(id: string): string {
  let code = 0;
  for (let i = 0; i < id.length; i++) code = (code + id.charCodeAt(i)) % 997;
  return DOT_STYLES[code % DOT_STYLES.length];
}

/**
 * TabStrip — Min-style tab management. Tabs are RAM-only: closing the app
 * or panicking wipes every trace. Middle-click closes (like Min).
 */
export default function TabStrip() {
  const tabs = useSpecter((s) => s.tabs);
  const activeTabId = useSpecter((s) => s.activeTabId);
  const activateTab = useSpecter((s) => s.activateTab);
  const closeTab = useSpecter((s) => s.closeTab);
  const newTab = useSpecter((s) => s.newTab);

  return (
    <div
      role="tablist"
      aria-label="Browser tabs"
      className="flex h-9 w-full items-stretch gap-px overflow-x-auto border-b border-zinc-800/80 bg-zinc-950/95 px-1 pt-1 no-scrollbar"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const label = tab.loading ? `${tab.title} (loading…)` : tab.title;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(tab.id);
              }
            }}
            onClick={() => activateTab(tab.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                activateTab(tab.id);
              }
            }}
            title={label}
            className={`group flex h-8 min-w-[120px] max-w-[200px] flex-none cursor-pointer items-center gap-2 rounded-t-md border-x border-t px-2.5 text-xs transition-colors ${
              active
                ? "border-zinc-800 bg-zinc-900 text-zinc-100"
                : "border-transparent bg-zinc-950 text-zinc-500 hover:bg-zinc-900/50 hover:text-zinc-300"
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 flex-none rounded-full ${
                tab.loading ? "animate-pulse bg-emerald-300" : dotStyle(tab.id)
              }`}
            />
            <span className="min-w-0 flex-1 truncate">{tab.title}</span>
            <button
              type="button"
              aria-label={`Close tab: ${tab.title}`}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              className="flex h-4 w-4 flex-none items-center justify-center rounded text-zinc-600 opacity-0 transition-all hover:bg-zinc-800 hover:text-zinc-200 focus:opacity-100 group-hover:opacity-100"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        );
      })}

      <button
        type="button"
        aria-label="New tab"
        onClick={() => newTab()}
        className="mb-1 ml-1 flex h-7 w-8 flex-none items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-emerald-300"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
