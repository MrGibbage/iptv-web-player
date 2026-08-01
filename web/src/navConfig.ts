// Shared between App.tsx (which owns `tab` state) and EpgGuide.tsx (which
// now renders its own copy of the nav — PLAN.md "Guide UI polish, round 3"
// — so a viewer never leaves the Guide screen's tight top-left hamburger to
// reach the rest of the app). One shared source for the tab list/labels
// avoids the two staying in sync by hand.

export type Tab = "providers" | "guide" | "vod" | "series" | "recordings" | "diagnostics";

export const TAB_LABELS: Record<Tab, string> = {
  providers: "Providers",
  guide: "Live TV / Guide",
  vod: "Movies",
  series: "TV Shows",
  recordings: "Recordings",
  diagnostics: "Diagnostics",
};

export const TAB_ORDER: Tab[] = ["providers", "guide", "vod", "series", "recordings", "diagnostics"];

// Providers/Diagnostics are deliberately not valid start screens — neither
// is a sensible place to land by default.
export type StartTab = "guide" | "vod" | "series" | "recordings";

export const START_TAB_OPTIONS: { value: StartTab; label: string }[] = [
  { value: "guide", label: "Live TV / Guide" },
  { value: "vod", label: "Movies" },
  { value: "series", label: "TV Shows" },
  { value: "recordings", label: "Recordings" },
];
