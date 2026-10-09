"use client";

import type { FormEvent } from "react";
import { motion } from "framer-motion";
import {
  EyeOff,
  Ghost,
  Github,
  Globe,
  Lock,
  Newspaper,
  Search,
  ShieldCheck,
  Youtube,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSpecter } from "@/store/specter";

/**
 * NewTabHero — start page of every fresh tab: encrypted search + one-click
 * launch tiles. Typing words searches; typing an address browses.
 */
export default function NewTabHero() {
  const query = useSpecter((s) => s.query);
  const setQuery = useSpecter((s) => s.setQuery);
  const omniboxNavigate = useSpecter((s) => s.omniboxNavigate);
  const openInBrowser = useSpecter((s) => s.openInBrowser);
  const safeSearch = useSpecter((s) => s.safeSearch);
  const setSafeSearch = useSpecter((s) => s.setSafeSearch);
  const recencyDays = useSpecter((s) => s.recencyDays);
  const setRecencyDays = useSpecter((s) => s.setRecencyDays);
  const sessionReady = useSpecter((s) => s.sessionReady);
  const uvStatus = useSpecter((s) => s.uvStatus);
  const uvAvailable = uvStatus === "ready";
  const booting = useSpecter((s) => s.booting);
  const retryEngine = useSpecter((s) => s.retryEngine);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // words → encrypted search · addresses → browse through the tunnel
    void omniboxNavigate(query);
  }

  const tiles = [
    { label: "Wikipedia", url: "https://en.wikipedia.org/wiki/Main_Page", icon: Newspaper },
    { label: "YouTube", url: "https://www.youtube.com", icon: Youtube },
    { label: "BBC News", url: "https://www.bbc.com/news", icon: Globe },
    { label: "Hacker News", url: "https://news.ycombinator.com", icon: Globe },
    { label: "GitHub", url: "https://github.com", icon: Github },
    { label: "Wikivoyage", url: "https://en.wikivoyage.org/wiki/Main_Page", icon: Newspaper },
  ];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center px-4 pb-10 pt-10 sm:pt-16">
      {/* brand */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className="flex flex-col items-center"
      >
        <div
          aria-hidden="true"
          className="flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-400/20 bg-emerald-400/10"
        >
          <Ghost className="h-8 w-8 text-emerald-400" />
        </div>
        <h1 className="mt-5 text-3xl font-semibold tracking-[0.3em] text-zinc-100">SPECTER</h1>
        <p className="mt-2 max-w-md text-center text-sm text-zinc-400">
          Search in total darkness. Browse the full web — images, video, everything —
          through an encrypted relay that never keeps a trace.
        </p>
      </motion.div>

      {/* search */}
      <motion.form
        role="search"
        onSubmit={handleSubmit}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.08, ease: "easeOut" }}
        className="mt-8 w-full"
      >
        <div className="flex h-14 w-full items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/70 px-3 transition-colors focus-within:border-emerald-400/50 focus-within:ring-1 focus-within:ring-emerald-400/30">
          <Search className="ml-1 h-5 w-5 flex-none text-zinc-500" aria-hidden="true" />
          <Input
            id="specter-search"
            name="query"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the unfiltered web… or type an address to browse"
            aria-label="Search the unfiltered web or type an address"
            autoComplete="off"
            spellCheck={false}
            className="h-auto min-w-0 flex-1 border-0 bg-transparent px-1 text-base text-zinc-100 shadow-none placeholder:text-zinc-500 focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent md:text-base"
          />
          <Button
            type="submit"
            aria-label="Run encrypted search"
            className="size-10 flex-none rounded-xl bg-emerald-400 text-zinc-950 hover:bg-emerald-300"
          >
            <Search className="size-4" aria-hidden="true" />
          </Button>
        </div>

        {/* shields row */}
        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
            <Switch
              checked={safeSearch}
              onCheckedChange={setSafeSearch}
              aria-label="Toggle Safe Search"
              className="data-[state=checked]:bg-emerald-400"
            />
            <ShieldCheck
              className={`h-3.5 w-3.5 ${safeSearch ? "text-emerald-400" : "text-zinc-600"}`}
              aria-hidden="true"
            />
            Safe Search
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <span className="sr-only">Time filter</span>
            <Select
              value={recencyDays === null ? "any" : String(recencyDays)}
              onValueChange={(v) => setRecencyDays(v === "any" ? null : Number(v))}
            >
              <SelectTrigger
                size="sm"
                className="h-8 w-[130px] border-zinc-800 bg-zinc-900/70 text-xs text-zinc-300"
                aria-label="Filter results by age"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-950">
                <SelectItem value="any" className="text-zinc-300">Any time</SelectItem>
                <SelectItem value="1" className="text-zinc-300">Past 24 hours</SelectItem>
                <SelectItem value="7" className="text-zinc-300">Past week</SelectItem>
                <SelectItem value="30" className="text-zinc-300">Past month</SelectItem>
                <SelectItem value="365" className="text-zinc-300">Past year</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>
      </motion.form>

      {/* launch tiles */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.16, ease: "easeOut" }}
        className="mt-10 w-full"
      >
        <p className="mb-3 text-center font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-600">
          Launch through the tunnel
        </p>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {tiles.map((tile) => (
            <button
              key={tile.label}
              type="button"
              onClick={() => openInBrowser(tile.url)}
              aria-label={`Open ${tile.label} through the encrypted browser`}
              className="group flex flex-col items-center gap-2 rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-2 py-4 text-zinc-400 transition-colors hover:border-emerald-400/30 hover:bg-emerald-400/5 hover:text-emerald-300"
            >
              <tile.icon className="h-5 w-5" aria-hidden="true" />
              <span className="text-center text-[11px] leading-tight">{tile.label}</span>
            </button>
          ))}
        </div>
      </motion.div>

      {/* badges + status */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.24 }}
        className="mt-10 flex flex-wrap items-center justify-center gap-2"
      >
        {[
          { icon: Lock, label: "AES-256-GCM" },
          { icon: EyeOff, label: "ZERO LOGS" },
          { icon: ShieldCheck, label: "TRACKERS BLOCKED" },
          { icon: Globe, label: uvAvailable ? "FULL BROWSER ENGINE" : "HARDENED RELAY" },
        ].map((badge) => (
          <span
            key={badge.label}
            className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900/50 px-3 py-1 font-mono text-[9px] uppercase tracking-widest text-zinc-500"
          >
            <badge.icon className="h-3 w-3 text-emerald-400/70" aria-hidden="true" />
            {badge.label}
          </span>
        ))}
      </motion.div>

      <p aria-live="polite" className="mt-5 font-mono text-[10px] text-zinc-600">
        {booting
          ? "negotiating encrypted channel…"
          : !sessionReady
            ? "channel offline — retry by reopening"
            : uvStatus === "booting"
              ? "channel established · starting browser engine…"
              : uvStatus === "ready"
                ? "channel established · browser engine online"
                : "channel established · BROWSER ENGINE OFFLINE"}
      </p>

      {sessionReady && uvStatus === "failed" ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => void retryEngine()}
          aria-label="Retry browser engine startup"
          className="mt-3 border-red-400/40 bg-transparent font-mono text-[10px] uppercase tracking-widest text-red-300 hover:bg-red-400/10 hover:text-red-200"
        >
          Retry browser engine
        </Button>
      ) : null}
    </div>
  );
}
