"use client";

import type { FormEvent } from "react";
import {
  EyeOff,
  Ghost,
  Globe,
  Lock,
  Search,
  ShieldCheck,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useSpecter } from "@/store/specter";

const RECENCY_OPTIONS: ReadonlyArray<{ value: string; label: string; days: number | null }> = [
  { value: "0", label: "Any time", days: null },
  { value: "1", label: "Past 24 hours", days: 1 },
  { value: "7", label: "Past week", days: 7 },
  { value: "30", label: "Past month", days: 30 },
  { value: "365", label: "Past year", days: 365 },
];

const FEATURES = [
  { icon: ShieldCheck, label: "Zero logs" },
  { icon: Lock, label: "Sealed queries" },
  { icon: Globe, label: "Unfiltered access" },
  { icon: EyeOff, label: "No trackers" },
] as const;

const EXAMPLES = [
  "quantum computing breakthroughs",
  "privacy tools 2025",
  "how does tor work",
] as const;

export default function SearchHero() {
  const booting = useSpecter((s) => s.booting);
  const sessionReady = useSpecter((s) => s.sessionReady);
  const query = useSpecter((s) => s.query);
  const setQuery = useSpecter((s) => s.setQuery);
  const search = useSpecter((s) => s.search);
  const safeSearch = useSpecter((s) => s.safeSearch);
  const setSafeSearch = useSpecter((s) => s.setSafeSearch);
  const recencyDays = useSpecter((s) => s.recencyDays);
  const setRecencyDays = useSpecter((s) => s.setRecencyDays);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void search();
  }

  function runExample(q: string) {
    setQuery(q);
    void search(q);
  }

  const recencyValue = recencyDays === null ? "0" : String(recencyDays);

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col items-center px-4 py-16 text-center md:py-24">
      {/* brand mark */}
      <div
        aria-hidden="true"
        className="flex h-20 w-20 items-center justify-center rounded-2xl border border-emerald-400/20 bg-emerald-400/10"
      >
        <Ghost className="h-12 w-12 text-emerald-400" />
      </div>
      <h1 className="mt-5 text-3xl font-semibold tracking-[0.3em] text-zinc-100 md:text-4xl">
        SPECTER
      </h1>

      <p className="mt-6 text-lg font-semibold text-zinc-100 md:text-xl">
        Search in total darkness.
      </p>
      <p className="mt-3 max-w-xl text-sm text-zinc-400 md:text-base">
        Queries are sealed with AES-256-GCM before they leave your browser.
        Results are never logged, never profiled, never shared. Every site opens
        through an encrypted relay that strips scripts and trackers.
      </p>

      {/* search form */}
      <form role="search" onSubmit={handleSubmit} className="mt-8 w-full">
        <div className="flex h-14 w-full items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/70 px-2.5 transition-colors focus-within:border-emerald-400/50 focus-within:ring-1 focus-within:ring-emerald-400/30">
          <Search className="ml-1.5 h-4 w-4 flex-none text-zinc-500" aria-hidden="true" />
          <Input
            id="specter-search"
            name="query"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the unfiltered web…"
            aria-label="Search the unfiltered web"
            autoComplete="off"
            spellCheck={false}
            className="h-auto min-w-0 flex-1 border-0 bg-transparent px-1 text-base text-zinc-100 shadow-none placeholder:text-zinc-500 focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent md:text-base"
          />
          <Button
            type="submit"
            aria-label="Run encrypted search"
            className="h-11 w-11 flex-none bg-emerald-400 text-zinc-950 hover:bg-emerald-300"
          >
            <Search className="size-5" aria-hidden="true" />
          </Button>
        </div>
      </form>

      {/* safe search + time filter */}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-4">
        <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-1 font-mono text-[11px] text-zinc-400">
          <ShieldCheck
            className={`h-4 w-4 flex-none ${safeSearch ? "text-emerald-400" : "text-zinc-600"}`}
            aria-hidden="true"
          />
          <span className="whitespace-nowrap">Safe Search</span>
          <Switch
            checked={safeSearch}
            onCheckedChange={setSafeSearch}
            aria-label="Toggle Safe Search"
            className="data-[state=checked]:bg-emerald-400 data-[state=unchecked]:bg-zinc-700"
          />
        </label>

        <Select
          value={recencyValue}
          onValueChange={(v) => {
            const option = RECENCY_OPTIONS.find((o) => o.value === v);
            setRecencyDays(option ? option.days : null);
          }}
        >
          <SelectTrigger
            aria-label="Filter results by time range"
            size="sm"
            className="h-10 w-[136px] border-zinc-800 bg-zinc-900/60 font-mono text-[11px] text-zinc-300 hover:border-zinc-700 data-[size=sm]:h-10 data-[size=sm]:w-[136px] sm:w-[150px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-zinc-800 bg-zinc-900 text-zinc-200">
            {RECENCY_OPTIONS.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                className="font-mono text-xs focus:bg-zinc-800 focus:text-emerald-300"
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* feature chips */}
      <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
        {FEATURES.map(({ icon: Icon, label }) => (
          <Badge
            key={label}
            variant="outline"
            className="border-zinc-800 bg-zinc-900/60 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-zinc-300"
          >
            <Icon className="text-emerald-400" aria-hidden="true" />
            {label}
          </Badge>
        ))}
      </div>

      {/* channel status */}
      <p aria-live="polite" className="mt-6 font-mono text-[11px]">
        {booting ? (
          <span className="animate-pulse text-zinc-500">
            ESTABLISHING SECURE CHANNEL…
          </span>
        ) : sessionReady ? (
          <span className="text-emerald-400">
            SECURE CHANNEL ESTABLISHED · AES-256-GCM
          </span>
        ) : (
          <span className="text-red-400">CHANNEL ERROR — RELOAD TO RETRY</span>
        )}
      </p>

      {/* example queries */}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => runExample(example)}
            aria-label={`Search for: ${example}`}
            className="flex min-h-11 items-center rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 font-mono text-[10px] text-zinc-400 transition-colors hover:border-emerald-400/30 hover:text-emerald-300"
          >
            {example}
          </button>
        ))}
      </div>
    </section>
  );
}
