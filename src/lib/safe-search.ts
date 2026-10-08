/**
 * SPECTER — Safe Search filter.
 * Server-side heuristic filtering of adult/explicit content in search results.
 * Always applied when the user's Safe Search shield is ON (default).
 */

const ADULT_TERMS = [
  "porn", "xxx", "nsfw", "nudes", "nude", "explicit sex", "hardcore sex",
  "camgirl", "cam girl", "onlyfans leak", "escort service", "hookers",
  "hentai", "erotic", "seduction", "fetish", "bdsm", "strip club",
  "adult video", "sex tape", "sexy girls", "hot singles",
];

const ADULT_HOSTS = [
  "pornhub", "xvideos", "xhamster", "redtube", "youporn", "onlyfans",
  "chaturbate", "stripchat", "brazzers", "adultfriendfinder", "ashley-madison",
  "ashleymadison", "hentai", "xnxx", "spankbang", "ehentai", "nhentai",
  "rule34", "fap", "camsoda", "bongacams", "livejasmin",
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

export function isExplicit(result: {
  name?: string;
  snippet?: string;
  url?: string;
  host_name?: string;
}): boolean {
  const host = (result.host_name ?? "").toLowerCase();
  if (ADULT_HOSTS.some((h) => host.includes(h))) return true;

  const haystack = normalize(`${result.name ?? ""} ${result.snippet ?? ""} ${result.url ?? ""}`);
  return ADULT_TERMS.some((term) => {
    const t = normalize(term);
    // word-boundary-ish match to avoid false positives on "sexton", "escort" in urls etc.
    return haystack.includes(` ${t} `) || haystack.startsWith(`${t} `) || haystack.endsWith(` ${t}`);
  });
}

export function filterResults<T>(
  results: T[],
  safeSearch: boolean
): { results: T[]; filteredCount: number } {
  if (!safeSearch) return { results, filteredCount: 0 };
  const kept = results.filter((r) => !isExplicit(r as { name?: string; snippet?: string; url?: string; host_name?: string }));
  return { results: kept, filteredCount: results.length - kept.length };
}
