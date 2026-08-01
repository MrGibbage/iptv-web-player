// Per-browser UI preferences (PLAN.md "Persisted UI settings") — deliberately
// localStorage, not a server-side setting. Two reasons: (1) it needs zero
// auth to already do the right thing when more than one person uses the same
// deployed instance from different devices (Skip's tablet vs. his daughter's
// — localStorage is inherently per-browser, so their preferences can never
// leak into each other's), and (2) these are pure UI convenience, not real
// data — losing them (private browsing, a cleared cache) just means falling
// back to sensible defaults, never a real problem the way losing a recording
// would be. Wrapped in try/catch since localStorage can throw in some
// contexts (e.g. storage disabled) — a UI preference silently not persisting
// is fine; a hard crash over it is not.

import { START_TAB_OPTIONS, type StartTab } from "./navConfig";
export type { StartTab };

const PREFIX = "iptv-web-player:";

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    // ignore — see file header
  }
}

const START_TAB_KEY = "startTab";
const VALID_START_TABS = START_TAB_OPTIONS.map((o) => o.value) as string[];

export function getStartTab(): StartTab {
  const stored = readRaw(START_TAB_KEY);
  return VALID_START_TABS.includes(stored ?? "") ? (stored as StartTab) : "guide";
}

export function setStartTab(tab: StartTab): void {
  writeRaw(START_TAB_KEY, tab);
}

// Last-selected category per screen (PLAN.md "Persisted UI settings") — the
// caller is responsible for checking the stored id still exists in whatever
// category list actually loaded (a provider switch, or the category simply
// no longer existing, both mean the id could be stale) before trusting it.
export type CategoryScreen = "guide" | "vod" | "series";

export function getLastCategory(screen: CategoryScreen): string | null {
  return readRaw(`category:${screen}`);
}

export function setLastCategory(screen: CategoryScreen, categoryId: string): void {
  writeRaw(`category:${screen}`, categoryId);
}
