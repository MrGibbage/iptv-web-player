import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api, proxiedImageUrl, type EffectiveProvider, type EpgBounds, type EpgProgram, type EpgSearchResult, type EpgStatus, type LiveCategory, type LiveChannel, type Profile, type ProviderSourceConfig } from "../api";
import { getCurrentProfileId, getLastCategory, setCurrentProfileId, setLastCategory, setStartTab, type StartTab } from "../localSettings";
import { TAB_LABELS, TAB_ORDER, type Tab } from "../navConfig";
import { Player } from "./Player";
import { RecordDialog } from "./RecordDialog";
import { StatsPopover } from "./StatsPopover";
import "./epg.css";

// Ported from Laomedeia (src/components/EpgGrid.tsx) — same virtualized
// channel-by-time grid, same staging-swap-backed data underneath it
// (already proven against the real sonix account's ~2,000 channels/100k+
// programs). Adapted from Electron IPC (window.epg.*) to this app's REST
// API.
//
// PLAN.md "Guide-centric Live TV" — this is now the *only* live-viewing
// screen; the separate preview-then-promote LiveTV.tsx built several passes
// ago was deleted and folded in here instead, once it became clear the grid
// itself already covers "pick a channel," leaving Live TV's plain list with
// no distinct job. Clicking a channel cell or a program block starts a
// permanent mini-player docked above the grid (`.epg-player-row`), with
// that program's details to its right.
//
// PLAN.md "Guide UI polish, round 3" (2026-08-01) — the biggest layout
// change yet: no more calendar-day pagination. The whole screen used to be
// scoped to one day at a time (Prev/Next day buttons, a `dayStartMs`/
// `dayEndMs` pair), but this provider's own EPG feed only ever covers ~2.4
// days total (see round 1's investigation) and horizontal scroll makes day
// buttons redundant anyway — so the grid is now one continuous scrollable
// window from the current hour through to the end of whatever data exists
// (`windowStartMs`/`windowEndMs` below), with no day concept left at all.
// The app-level nav (Providers/Guide/Movies/...), category/provider
// pickers, the "Start screen" preference, and Refresh all collapsed into a
// single hamburger docked at the top-left corner of the player row (see
// App.tsx — its own nav row is hidden while this tab is active, to avoid
// two stacked hamburgers). Search stays permanently visible instead (a
// deliberate exception — round 2 tried hiding it in a menu too and it was
// worse); round 4 moved it again, into the details column itself (pushed
// toward the bottom via CSS, below whatever program details or the empty
// placeholder is showing) rather than costing its own row above everything.
//
// Still standalone rather than prop-driven for its own data (provider list,
// categories, channels, programs) — there's no shared app-level state for
// that yet, same pattern as VodBrowser.tsx/SeriesBrowser.tsx. `tab`/
// `onSelectTab`/`startTabPref`/`onStartTabChange` are the one exception,
// passed down from App.tsx purely so this screen's own hamburger can offer
// the same nav-links + start-screen controls App.tsx's own hamburger has on
// every other screen.

// Keep CH_COL_W in sync with .epg-channel-cell width in epg.css.
const PX_PER_MIN = 4;
const ROW_H = 52;
const CH_COL_W = 220;
const RULER_H = 36;
const STATUS_POLL_MS = 30_000;
const HOUR_MS = 60 * 60 * 1000;
// Fallback window length when bounds aren't known yet (e.g. before the
// first status/bounds fetch resolves) — arbitrary but generous; real bounds
// replace it within a second or two of load.
const FALLBACK_WINDOW_MS = 24 * HOUR_MS;

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function fmtDayTime(ms: number): string {
  return `${fmtDay(ms)} ${fmtTime(ms)}`;
}

function fmtAgo(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function currentHourStart(): number {
  return Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
}

interface SelectedProgram {
  program: EpgProgram;
  channelName: string;
}

// EPG data is a fixed-size sliding window (this provider's own XMLTV feed
// covers roughly 2.4 days total, not "a couple of days ahead of whenever we
// last checked" — see PLAN.md "Guide UI polish") — a refresh that lands with
// little runway left before "now" catches up to the end of that window is a
// real, if mundane, provider-side timing thing (their feed's own coverage at
// the moment it was fetched), not a bug to work around once, just something
// this should self-heal from continuously. STALE_MARGIN_MS is how much
// forward runway is considered "enough" before auto-triggering a refresh.
const STALE_MARGIN_MS = 60 * 60 * 1000;

// PLAN.md "Guide UI polish, round 6" (phone layout) — a compound query
// rather than just a width check: phone *landscape* (~915x412 on a real
// device, confirmed via screenshot) is wider than any sensible portrait-only
// breakpoint but still has nowhere near a tablet's landscape height
// (~1280x800), so max-height alone catches it without also catching a
// tablet turned sideways. Neither condition fires for a tablet in either
// orientation — confirmed against this app's actual tested tablet
// dimensions (1280x800).
const PHONE_MEDIA_QUERY = "(max-width: 600px), (max-height: 500px)";

type Props = {
  tab: Tab;
  onSelectTab: (t: Tab) => void;
  startTabPref: StartTab;
  onStartTabChange: (v: StartTab) => void;
};

export function EpgGuide({ tab, onSelectTab, startTabPref, onStartTabChange }: Props) {
  const [providers, setProviders] = useState<EffectiveProvider[] | "loading" | "error">("loading");
  const [providerId, setProviderId] = useState<number | null>(null);
  const [categories, setCategories] = useState<LiveCategory[] | "loading" | "error">("loading");
  const [categoryId, setCategoryId] = useState<string>("");
  const [channels, setChannels] = useState<LiveChannel[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // The left edge of the whole scrollable window — the current hour at the
  // moment the provider was (re)selected. Deliberately not re-derived every
  // tick: the point is "don't default/allow scrolling into stuff that
  // already aired," not a live-updating boundary that would need to shove
  // an open scroll position around every hour on its own.
  const [windowStartMs, setWindowStartMs] = useState(() => currentHourStart());
  const [programs, setPrograms] = useState<Map<string, EpgProgram[]>>(new Map());
  const requestedIdsRef = useRef(new Set<string>());
  const [selected, setSelected] = useState<SelectedProgram | null>(null);
  const [status, setStatus] = useState<EpgStatus | null>(null);
  const [bounds, setBounds] = useState<EpgBounds | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<EpgSearchResult[]>([]);
  const [jumpTarget, setJumpTarget] = useState<{ channelId: string; timeMs: number } | null>(null);
  const lastRefreshRef = useRef<number | null>(null);
  const [previewChannel, setPreviewChannel] = useState<{ channelId: string; name: string } | null>(null);
  const [recorderMode, setRecorderMode] = useState(false);
  const [profiles, setProfiles] = useState<Profile[] | "loading" | "error">("loading");
  const [profileId, setProfileId] = useState<number | null>(() => getCurrentProfileId());
  const [recordTarget, setRecordTarget] = useState<{ channel: LiveChannel; startMs: number; stopMs: number } | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [epgInfoOpen, setEpgInfoOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const autoRefreshTriggeredRef = useRef(false);
  const [isPhone, setIsPhone] = useState(() => window.matchMedia(PHONE_MEDIA_QUERY).matches);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  // Click-outside-to-close for the combined hamburger panel.
  useEffect(() => {
    if (!menuOpen) return;
    function handlePointerDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [menuOpen]);

  // One MediaQueryList for the whole compound query (see PHONE_MEDIA_QUERY) —
  // "change" fires whenever the list's overall match result flips, covering
  // both a real device rotation and a resized dev-tools viewport.
  useEffect(() => {
    const mq = window.matchMedia(PHONE_MEDIA_QUERY);
    const update = () => setIsPhone(mq.matches);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Auto-dismiss (PLAN.md "Guide UI polish, round 6") — the phone layout has
  // no permanent status area to leave an error sitting in, so this surfaces
  // just long enough to read then clears itself.
  useEffect(() => {
    if (!phoneError) return;
    const timer = setTimeout(() => setPhoneError(null), 4000);
    return () => clearTimeout(timer);
  }, [phoneError]);

  const windowEndMs = bounds?.maxStopMs != null && bounds.maxStopMs > windowStartMs ? bounds.maxStopMs : windowStartMs + FALLBACK_WINDOW_MS;
  const windowMinutes = (windowEndMs - windowStartMs) / 60_000;
  const contentWidth = CH_COL_W + windowMinutes * PX_PER_MIN;
  const searchActive = searchQuery.trim().length > 0;
  const visibleEpgChannelIds = useMemo(() => new Set(channels.flatMap((channel) => (channel.epgChannelId ? [channel.epgChannelId] : []))), [channels]);
  const channelsByEpgId = useMemo(() => {
    const map = new Map<string, LiveChannel>();
    for (const c of channels) {
      if (c.epgChannelId && !map.has(c.epgChannelId)) map.set(c.epgChannelId, c);
    }
    return map;
  }, [channels]);

  const rowVirtualizer = useVirtualizer({
    count: channels.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  const visibleStart = virtualItems[0]?.index ?? 0;
  const visibleEnd = virtualItems[virtualItems.length - 1]?.index ?? -1;

  // Provider list, once on mount.
  useEffect(() => {
    api
      .get<EffectiveProvider[]>("/effective-providers")
      .then((list) => {
        setProviders(list);
        if (list.length > 0) setProviderId(list[0].id);
      })
      .catch(() => setProviders("error"));
  }, []);

  // Recording (PLAN.md "Recording support") only exists via iptv-recorder —
  // fetched once to gate the "⏺ Record" button below, same
  // acceptable-per-page-duplication pattern as everything else here.
  useEffect(() => {
    api
      .get<ProviderSourceConfig>("/config/provider-source")
      .then((c) => setRecorderMode(c.mode === "recorder"))
      .catch(() => {});
  }, []);

  // PLAN.md "Profiles" — only meaningful once recorder mode is confirmed
  // (profiles are iptv-recorder's own concept, nothing to fetch in local
  // mode).
  useEffect(() => {
    if (!recorderMode) return;
    api
      .get<Profile[]>("/profiles")
      .then(setProfiles)
      .catch(() => setProfiles("error"));
  }, [recorderMode]);

  function handleProfileChange(value: string) {
    const id = value === "" ? null : Number(value);
    setProfileId(id);
    setCurrentProfileId(id);
  }

  // Categories on provider change. Restores the last category chosen on
  // this screen (PLAN.md "Persisted UI settings") once the real list loads
  // — only if that id still exists in it; a stale id (switched providers,
  // or the category itself no longer exists) just falls back to "All
  // categories" the same as if nothing had ever been chosen.
  useEffect(() => {
    if (providerId === null) return;
    setCategories("loading");
    setCategoryId("");
    let current = true;
    api
      .get<LiveCategory[]>(`/providers/${providerId}/live/categories`)
      .then((result) => {
        if (!current) return;
        setCategories(result);
        const stored = getLastCategory("guide");
        if (stored && result.some((c) => c.categoryId === stored)) setCategoryId(stored);
      })
      .catch(() => {
        if (current) setCategories("error");
      });
    return () => {
      current = false;
    };
  }, [providerId]);

  function handleCategoryChange(value: string) {
    setCategoryId(value);
    setLastCategory("guide", value);
  }

  function handleStartTabSelect(value: StartTab) {
    onStartTabChange(value);
    setStartTab(value);
  }

  // Channels on provider/category change. Same stale-response guard as
  // LiveChannels.tsx, for the same reason: an unfiltered "all categories"
  // fetch can be far slower than a filtered one and land after it.
  useEffect(() => {
    if (providerId === null) return;
    let current = true;
    const query = categoryId ? `?categoryId=${encodeURIComponent(categoryId)}` : "";
    api
      .get<LiveChannel[]>(`/providers/${providerId}/live/channels${query}`)
      .then((result) => {
        if (current) setChannels(result);
      })
      .catch(() => {
        if (current) setChannels([]);
      });
    return () => {
      current = false;
    };
  }, [providerId, categoryId]);

  // Keep the current time position while returning the newly selected
  // category to its first channel row.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [categoryId]);

  const resetProgramCache = () => {
    requestedIdsRef.current = new Set();
    setPrograms(new Map());
  };

  const refreshStatus = (id: number) => {
    api
      .get<EpgStatus>(`/providers/${id}/epg/status`)
      .then((s) => {
        setStatus(s);
        if (s.lastRefreshMs !== lastRefreshRef.current) {
          lastRefreshRef.current = s.lastRefreshMs;
          resetProgramCache();
          api.get<EpgBounds>(`/providers/${id}/epg/bounds`).then(setBounds);
        }
      })
      .catch(() => {});
  };

  // Initial status/bounds on provider change, then a plain poll every 30s —
  // this app has no push channel for refresh progress yet (PLAN.md Open
  // Questions), so background refreshes (the hourly scheduler) only show up
  // here once this notices lastRefreshMs changed.
  useEffect(() => {
    if (providerId === null) return;
    lastRefreshRef.current = null;
    autoRefreshTriggeredRef.current = false;
    resetProgramCache();
    setBounds(null);
    setWindowStartMs(currentHourStart());
    refreshStatus(providerId);
    const timer = setInterval(() => {
      setNowMs(Date.now());
      refreshStatus(providerId);
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  // Fetch programs for visible rows (plus overscan) that aren't cached yet
  // — the whole window (up to ~2.4 days), not a single day.
  //
  // Real bug found via testing (PLAN.md "Guide UI polish, round 4"): on
  // first paint, before the flex-fill height chain (main -> .guide-container
  // -> .epg-root -> .epg-scroll) has fully settled, the row virtualizer can
  // transiently measure .epg-scroll's height as far larger than its real
  // rendered size and report almost the *entire* channel list as "visible"
  // in one shot — with "All categories" selected (4,518 live channels, a
  // real provider list far bigger than the EPG's own ~1,974 known channels)
  // that produced a single ~4,500-id request URL long enough to hit a hard
  // HTTP 431 (request header fields too large). No realistic viewport ever
  // actually shows anywhere near 200 rows at once (200 * ROW_H = 10,400px),
  // so an apparent range wider than that is treated as exactly what it is —
  // a stale/incorrect measurement, not a real visible range — and skipped;
  // the very next real layout pass reports the true (small) range and this
  // effect re-runs normally.
  useEffect(() => {
    if (providerId === null || visibleEnd < 0 || visibleEnd - visibleStart > 200) return;
    const timer = setTimeout(() => {
      const ids: string[] = [];
      for (let i = visibleStart; i <= visibleEnd && i < channels.length; i++) {
        const epgId = channels[i].epgChannelId;
        if (epgId && !requestedIdsRef.current.has(epgId)) {
          requestedIdsRef.current.add(epgId);
          ids.push(epgId);
        }
      }
      if (ids.length === 0) return;
      api
        .get<EpgProgram[]>(`/providers/${providerId}/epg/programs?channelIds=${ids.map(encodeURIComponent).join(",")}&from=${windowStartMs}&to=${windowEndMs}`)
        .then((rows) => {
          setPrograms((prev) => {
            const next = new Map(prev);
            for (const id of ids) next.set(id, []);
            for (const row of rows) next.get(row.channelId)?.push(row);
            return next;
          });
        })
        .catch(() => {
          for (const id of ids) requestedIdsRef.current.delete(id);
        });
    }, 120);
    return () => clearTimeout(timer);
  }, [providerId, visibleStart, visibleEnd, windowStartMs, windowEndMs, channels, programs]);

  // Debounced full-text search over channel name + title + description.
  useEffect(() => {
    if (providerId === null || !searchActive) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(() => {
      api.get<EpgSearchResult[]>(`/providers/${providerId}/epg/search?q=${encodeURIComponent(searchQuery.trim())}`).then((results) => {
        setSearchResults(results.filter((r) => visibleEpgChannelIds.has(r.channelId)));
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [providerId, searchQuery, searchActive, visibleEpgChannelIds]);

  // 15 minutes of lead-in before the target time — reasonable context for a
  // search result ("how did we get here"). A target before windowStartMs
  // (already-aired relative to the window's own left edge) has no position
  // to scroll to at all — Math.max(0, ...) just lands at the very start
  // rather than erroring.
  const scrollToTime = (timeMs: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const minutes = (timeMs - windowStartMs) / 60_000;
    el.scrollLeft = Math.max(0, (minutes - 15) * PX_PER_MIN);
  };

  // No "scroll to now" effect needed anymore (PLAN.md "Guide UI polish,
  // round 3") — windowStartMs *is* the current hour and position 0 in the
  // scrollable content, so a fresh scroll container's default scrollLeft=0
  // already lands exactly there. That's also why the old "Now" button is
  // gone: there's nothing left to jump back to that isn't already the
  // default.

  // Apply a pending jump (from a search result) once the grid is actually
  // showing (searchActive false, channels loaded) — no day-matching wait
  // needed anymore, just waiting for the search-results view to close back
  // to the grid.
  useEffect(() => {
    if (!jumpTarget || searchActive) return;
    const rowIndex = channels.findIndex((c) => c.epgChannelId === jumpTarget.channelId);
    if (rowIndex >= 0) rowVirtualizer.scrollToIndex(rowIndex, { align: "center" });
    scrollToTime(jumpTarget.timeMs);
    setJumpTarget(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTarget, searchActive, channels]);

  // Starts/switches the permanent mini-player dock (PLAN.md "Guide-centric
  // Live TV") — a no-op if it's already showing this channel, so re-clicking
  // the same channel's cell or another of its program blocks doesn't
  // interrupt the running session.
  const startPreview = (channelId: string, name: string) => {
    if (previewChannel?.channelId !== channelId) {
      setPreviewChannel({ channelId, name });
    }
  };

  const liveProgramFor = (channel: LiveChannel): EpgProgram | null => {
    if (!channel.epgChannelId) return null;
    const list = programs.get(channel.epgChannelId);
    return list?.find((p) => p.startMs <= nowMs && p.stopMs > nowMs) ?? null;
  };

  // Shared by both the channel-cell click (whatever's on now, or nothing if
  // there's no data) and a specific program-block click (that exact slot,
  // past/present/future) — both also start/switch the mini-player, since
  // there's no separate "just look, don't play" gesture on this screen.
  const selectChannelAndProgram = (channel: LiveChannel, program: EpgProgram | null) => {
    setSelected(program ? { program, channelName: channel.name } : null);
    startPreview(channel.channelId, channel.name);
  };

  const openSearchResult = (result: EpgSearchResult) => {
    setSearchQuery("");
    setSelected({ program: result, channelName: result.channelName });
    setJumpTarget({ channelId: result.channelId, timeMs: result.startMs });
    const channel = channelsByEpgId.get(result.channelId);
    if (channel) startPreview(channel.channelId, channel.name);
  };

  const refreshing = status?.state === "refreshing";
  const hasData = (status?.programCount ?? 0) > 0;

  const handleRefresh = () => {
    if (providerId === null) return;
    setStatus((s) => (s ? { ...s, state: "refreshing", phase: "download" } : s));
    api.post<EpgStatus>(`/providers/${providerId}/epg/refresh`, { force: true }).then((s) => {
      setStatus(s);
      if (s.lastRefreshMs !== lastRefreshRef.current) {
        lastRefreshRef.current = s.lastRefreshMs;
        resetProgramCache();
        api.get<EpgBounds>(`/providers/${providerId}/epg/bounds`).then(setBounds);
      }
    });
  };

  // Auto-refresh once when the cached guide doesn't reach far enough past
  // "now" to be useful — no reason to make someone notice a blank grid and
  // click Refresh themselves. Guarded by a ref (not state) so it fires at
  // most once per provider selection regardless of how often the 30s status
  // poll re-runs this effect; if the provider's own feed genuinely has no
  // more forward data, hammering it every 30s wouldn't fix that anyway.
  //
  // Real bug found via testing (PLAN.md "Guide UI polish, round 4"): status
  // resolving does NOT mean bounds has too — refreshStatus() fetches bounds
  // as a separate, slightly-later async call, only once it notices
  // lastRefreshMs changed. This effect re-runs the instant either dependency
  // changes, so it was firing once with status resolved but bounds still
  // null — read as "out of runway" (bounds?.maxStopMs == null) — a spurious
  // forced refresh on nearly every single page load, confirmed in the
  // server's own logs. status.lastRefreshMs === null (truly never refreshed)
  // is the one legitimate case to still act on before bounds exists at all,
  // since bounds will never arrive on its own in that case.
  useEffect(() => {
    if (!status) return;
    if (autoRefreshTriggeredRef.current || refreshing) return;
    if (bounds === null && status.lastRefreshMs !== null) return;
    const outOfRunway = bounds?.maxStopMs == null || Date.now() > bounds.maxStopMs - STALE_MARGIN_MS;
    if (outOfRunway) {
      autoRefreshTriggeredRef.current = true;
      handleRefresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, status]);

  const statusText = (() => {
    if (!status) return "";
    if (status.state === "refreshing") {
      return status.phase === "download" ? "Downloading guide…" : "Indexing guide…";
    }
    if (status.state === "error") return `Guide refresh failed: ${status.error}`;
    if (status.lastRefreshMs == null) return "Guide never refreshed";
    return `Updated ${fmtAgo(status.lastRefreshMs)} · ${status.channelCount.toLocaleString()} channels · ${status.programCount.toLocaleString()} programs`;
  })();

  if (providers === "loading") return <p>Loading providers…</p>;
  if (providers === "error") return <p className="error">Could not load providers.</p>;
  if (providers.length === 0) return <p className="muted">No providers configured yet.</p>;

  const ticks = [];
  for (let m = 0; m < windowMinutes; m += 30) {
    const tickMs = windowStartMs + m * 60_000;
    ticks.push(
      <div key={m} className="epg-tick" style={{ left: CH_COL_W + m * PX_PER_MIN, width: 30 * PX_PER_MIN }}>
        {m % 60 === 0 ? fmtTime(tickMs) : ""}
      </div>,
    );
  }

  const nowInWindow = nowMs >= windowStartMs && nowMs < windowEndMs;
  const nowLeft = CH_COL_W + ((nowMs - windowStartMs) / 60_000) * PX_PER_MIN;

  return (
    <div className="epg-root">
      <div className={isPhone ? "epg-phone-toolbar" : "epg-player-row"}>
        <div className="epg-menu-col" ref={menuRef}>
          <button type="button" className="hamburger-trigger brand-trigger" aria-label="Menu" onClick={() => setMenuOpen((v) => !v)}>
            🔱
          </button>
          {menuOpen && (
            <div className="hamburger-panel">
              {TAB_ORDER.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={tab === t ? "active" : ""}
                  onClick={() => {
                    onSelectTab(t);
                    setMenuOpen(false);
                  }}
                >
                  {TAB_LABELS[t]}
                </button>
              ))}
              <div className="hamburger-divider" />
              {providers.length > 1 && (
                <select value={providerId ?? ""} onChange={(e) => setProviderId(Number(e.target.value))}>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
              <select value={categoryId} onChange={(e) => handleCategoryChange(e.target.value)} disabled={categories === "loading" || categories === "error"}>
                <option value="">All categories</option>
                {categories !== "loading" &&
                  categories !== "error" &&
                  categories.map((c) => (
                    <option key={c.categoryId} value={c.categoryId}>
                      {c.categoryName}
                    </option>
                  ))}
              </select>
              <div className="hamburger-divider" />
              <label className="hamburger-pref">
                Start screen
                <select value={startTabPref} onChange={(e) => handleStartTabSelect(e.target.value as StartTab)}>
                  {TAB_ORDER.filter((t): t is StartTab => t === "guide" || t === "vod" || t === "series" || t === "recordings").map((t) => (
                    <option key={t} value={t}>
                      {TAB_LABELS[t]}
                    </option>
                  ))}
                </select>
              </label>
              {recorderMode && (
                <label className="hamburger-pref">
                  Who's watching
                  <select value={profileId ?? ""} onChange={(e) => handleProfileChange(e.target.value)} disabled={profiles === "loading" || profiles === "error"}>
                    <option value="">No profile selected</option>
                    {profiles !== "loading" &&
                      profiles !== "error" &&
                      profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <div className="hamburger-divider" />
              <button type="button" onClick={handleRefresh} disabled={refreshing}>
                {refreshing ? "Refreshing…" : "Refresh guide"}
              </button>
            </div>
          )}
        </div>
        {/* PLAN.md "Guide UI polish, round 6" — no permanent dock or details
            column at all on phone: no placeholder when nothing's selected,
            just the grid. Program details move to the transient bottom
            sheet below instead (rendered outside this row, since it's an
            overlay, not part of the toolbar's own flex layout). */}
        {!isPhone && (
          <>
            <div className="epg-player-dock">
              {previewChannel && providerId !== null ? (
                <>
                  <Player providerId={providerId} kind="live" mediaId={previewChannel.channelId} channelName={previewChannel.name} compact onClose={() => setPreviewChannel(null)} />
                  <button type="button" className="epg-stats-trigger" title="Stream stats" onClick={() => setStatsOpen((v) => !v)}>
                    ⓘ
                  </button>
                  {statsOpen && <StatsPopover providerId={providerId} channelId={previewChannel.channelId} onClose={() => setStatsOpen(false)} />}
                </>
              ) : (
                <div className="epg-player-placeholder">Select a channel to preview it here.</div>
              )}
            </div>
            <div className="epg-player-details">
              {selected ? (
                <>
                  <div className="epg-detail-title">{selected.program.title}</div>
                  <div className="epg-detail-meta">
                    {selected.channelName} · {fmtDay(selected.program.startMs)} {fmtTime(selected.program.startMs)}–{fmtTime(selected.program.stopMs)}
                  </div>
                  <div className="epg-detail-desc">{selected.program.description || "No description."}</div>
                  {recorderMode && providerId !== null && channelsByEpgId.has(selected.program.channelId) && (
                    <div className="row-actions" style={{ marginTop: 10 }}>
                      <button
                        type="button"
                        onClick={() =>
                          setRecordTarget({
                            channel: channelsByEpgId.get(selected.program.channelId)!,
                            startMs: selected.program.startMs,
                            stopMs: selected.program.stopMs,
                          })
                        }
                      >
                        ⏺ Record
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="epg-detail-empty">Select a program to see details.</div>
              )}
              <input className="epg-search-input" type="search" placeholder="Search channels, titles, descriptions…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
            </div>
          </>
        )}
        {isPhone && (
          <input className="epg-search-input" type="search" placeholder="Search channels, titles, descriptions…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
        )}
      </div>

      {isPhone && previewChannel && providerId !== null && (
        <div className="epg-phone-player-hidden">
          <Player
            providerId={providerId}
            kind="live"
            mediaId={previewChannel.channelId}
            channelName={previewChannel.name}
            hideChrome
            autoFullscreen
            onFullscreenExit={() => setPreviewChannel(null)}
            onError={(message) => {
              setPhoneError(message);
              setPreviewChannel(null);
            }}
            onClose={() => setPreviewChannel(null)}
          />
        </div>
      )}

      {isPhone && phoneError && <div className="epg-phone-toast">{phoneError}</div>}

      {isPhone && selected && (
        <div className="epg-phone-sheet-backdrop" onClick={() => setSelected(null)}>
          <div className="epg-phone-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="epg-detail-title">{selected.program.title}</div>
            <div className="epg-detail-meta">
              {selected.channelName} · {fmtDay(selected.program.startMs)} {fmtTime(selected.program.startMs)}–{fmtTime(selected.program.stopMs)}
            </div>
            <div className="epg-detail-desc">{selected.program.description || "No description."}</div>
            <div className="row-actions" style={{ marginTop: 10 }}>
              <button
                type="button"
                onClick={() => {
                  const channel = channelsByEpgId.get(selected.program.channelId);
                  if (channel) startPreview(channel.channelId, channel.name);
                  setSelected(null);
                }}
              >
                ▶ Watch live
              </button>
              {recorderMode && providerId !== null && channelsByEpgId.has(selected.program.channelId) && (
                <button
                  type="button"
                  onClick={() => {
                    setRecordTarget({
                      channel: channelsByEpgId.get(selected.program.channelId)!,
                      startMs: selected.program.startMs,
                      stopMs: selected.program.stopMs,
                    });
                    setSelected(null);
                  }}
                >
                  ⏺ Record
                </button>
              )}
              <button type="button" className="button-link" onClick={() => setSelected(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {recordTarget && providerId !== null && (
        <RecordDialog
          providerId={providerId}
          channelId={recordTarget.channel.channelId}
          channelName={recordTarget.channel.name}
          initialStart={new Date(recordTarget.startMs)}
          initialEnd={new Date(recordTarget.stopMs)}
          onClose={() => setRecordTarget(null)}
          onScheduled={() => setRecordTarget(null)}
        />
      )}

      {searchActive ? (
        <div className="epg-search-results">
          {searchResults.length === 0 ? (
            <div className="epg-detail-empty" style={{ padding: 16 }}>
              No matches.
            </div>
          ) : (
            searchResults.map((r) => {
              const isLive = r.startMs <= nowMs && r.stopMs > nowMs;
              return (
                <div key={r.id} className={`epg-search-result${isLive ? " epg-sr-live" : ""}`} onClick={() => openSearchResult(r)}>
                  <span className="epg-sr-time">
                    {fmtDay(r.startMs)} {fmtTime(r.startMs)}–{fmtTime(r.stopMs)}
                  </span>
                  {isLive && <span className="epg-sr-live-badge">LIVE</span>}
                  <span className="epg-sr-channel">{r.channelName}</span>
                  <span className="epg-sr-title">{r.title}</span>
                  <span className="epg-sr-desc">{r.description}</span>
                </div>
              );
            })
          )}
        </div>
      ) : !hasData ? (
        <div className="epg-empty-state">
          {refreshing ? (
            <>
              <div className="epg-spinner" />
              <p className="epg-empty-title">{status?.phase === "download" ? "Downloading your guide…" : "Indexing your guide…"}</p>
              <p className="epg-empty-sub">The first download can take a minute or two — the grid appears automatically when it finishes.</p>
            </>
          ) : status?.state === "error" ? (
            <>
              <p className="epg-empty-title">Couldn't refresh the guide</p>
              <p className="epg-empty-sub">{status.error}</p>
              <button onClick={handleRefresh}>Try again</button>
            </>
          ) : (
            <>
              <p className="epg-empty-title">No guide data yet</p>
              <p className="epg-empty-sub">Download the program guide from your provider to fill in the grid. After the first download it refreshes automatically in the background.</p>
              <button onClick={handleRefresh}>Download guide</button>
            </>
          )}
        </div>
      ) : (
        <div className="epg-scroll" ref={scrollRef}>
          <div style={{ width: contentWidth, height: RULER_H + rowVirtualizer.getTotalSize(), position: "relative" }}>
            <div className="epg-ruler" style={{ height: RULER_H, width: "100%" }}>
              {ticks}
              <div className="epg-ruler-corner" style={{ width: CH_COL_W }}>
                Channel
                <button type="button" className="epg-info-trigger" title="Guide info" onClick={() => setEpgInfoOpen((v) => !v)}>
                  ⓘ
                </button>
                {epgInfoOpen && (
                  <div className="stats-popover epg-info-popover">
                    <div className="page-header">
                      <strong>Guide info</strong>
                      <button type="button" className="button-link" onClick={() => setEpgInfoOpen(false)}>
                        Close
                      </button>
                    </div>
                    <p className="muted">
                      Showing {fmtDayTime(windowStartMs)} – {fmtDayTime(windowEndMs)}
                    </p>
                    <p className={status?.state === "error" ? "error" : "muted"}>{statusText}</p>
                  </div>
                )}
              </div>
            </div>

            {nowInWindow && <div className="epg-now-line" style={{ left: nowLeft, height: RULER_H + rowVirtualizer.getTotalSize() }} />}

            {virtualItems.map((vi) => {
              const channel = channels[vi.index];
              const progs = channel.epgChannelId ? programs.get(channel.epgChannelId) : undefined;
              const loaded = channel.epgChannelId != null && progs !== undefined;
              return (
                <div key={vi.key} className="epg-row" style={{ top: RULER_H + vi.start, height: vi.size, width: contentWidth }}>
                  <div
                    className="epg-channel-cell"
                    title={channel.name}
                    onClick={() => {
                      // PLAN.md "Guide UI polish, round 6" — on phone,
                      // tapping the channel itself jumps straight to
                      // fullscreen (no details step); tapping a specific
                      // program block below opens the transient sheet
                      // instead of also auto-playing (see that handler).
                      if (isPhone) {
                        startPreview(channel.channelId, channel.name);
                      } else {
                        selectChannelAndProgram(channel, liveProgramFor(channel));
                      }
                    }}
                  >
                    {channel.streamIcon && <img src={proxiedImageUrl(channel.streamIcon)} alt="" loading="lazy" />}
                    <span>{channel.name}</span>
                  </div>
                  {progs?.map((p) => {
                    const clampedStart = Math.max(p.startMs, windowStartMs);
                    const clampedStop = Math.min(p.stopMs, windowEndMs);
                    const left = CH_COL_W + ((clampedStart - windowStartMs) / 60_000) * PX_PER_MIN;
                    const width = Math.max(6, ((clampedStop - clampedStart) / 60_000) * PX_PER_MIN - 2);
                    const isSelected = selected?.program.id === p.id;
                    const isPast = p.stopMs <= nowMs;
                    return (
                      <div
                        key={p.id}
                        className={`epg-block${isSelected ? " epg-block-selected" : ""}${isPast ? " epg-block-past" : ""}`}
                        style={{ left, width }}
                        title={p.title}
                        onClick={() => {
                          // On phone, a program block only opens the
                          // transient details sheet (with its own explicit
                          // "▶ Watch live" action) rather than immediately
                          // starting playback — reading what's on later
                          // today shouldn't yank the screen into fullscreen.
                          if (isPhone) {
                            setSelected({ program: p, channelName: channel.name });
                          } else {
                            selectChannelAndProgram(channel, p);
                          }
                        }}
                      >
                        <div className="epg-block-title">{p.title}</div>
                        <div className="epg-block-time">
                          {fmtTime(p.startMs)}–{fmtTime(p.stopMs)}
                        </div>
                      </div>
                    );
                  })}
                  {(channel.epgChannelId == null || (loaded && progs!.length === 0)) && <div className="epg-no-data">No guide data</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
