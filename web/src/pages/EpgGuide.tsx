import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api, type EffectiveProvider, type EpgBounds, type EpgProgram, type EpgSearchResult, type EpgStatus, type LiveCategory, type LiveChannel, type PlayerSettings, type ProviderSourceConfig } from "../api";
import { Player } from "./Player";
import { RecordDialog } from "./RecordDialog";
import "./epg.css";

// Ported from Laomedeia (src/components/EpgGrid.tsx) — same virtualized
// channel-by-time grid, same staging-swap-backed data underneath it
// (already proven against the real sonix account's ~2,000 channels/100k+
// programs in the previous session). Adapted from Electron IPC
// (window.epg.*) to this app's REST API.
//
// PLAN.md "Guide-centric Live TV" — this is now the *only* live-viewing
// screen; the separate preview-then-promote LiveTV.tsx built the previous
// pass was deleted and folded in here instead, once it became clear the
// grid itself already covers "pick a channel," leaving Live TV's plain list
// with no distinct job. Clicking a channel cell or a program block starts a
// permanent mini-player docked above the grid (`.epg-player-row`), with
// that program's details to its right — the same `compact`/`onPromote`/
// `previewTimeoutSecs` mechanism from that pass, just docked inline instead
// of floating, and reused here directly rather than re-invented. The
// selected program's channelId is an XMLTV/EPG id, a different id space
// than the live channel's own channelId (Xtream stream_id or M3U URL) —
// `channelsByEpgId` below is the reverse lookup from one to the other, same
// as before.
//
// Still standalone rather than prop-driven: there's no shared app-level
// state yet (only a few other pages exist), so this page fetches its own
// provider/category/channel list independently, same pattern as
// VodBrowser.tsx/SeriesBrowser.tsx — acceptable duplication for now, worth
// revisiting if/when multiple pages need to share a selection.

// Keep CH_COL_W in sync with .epg-channel-cell width in epg.css.
const PX_PER_MIN = 4;
const ROW_H = 52;
const CH_COL_W = 220;
const RULER_H = 36;
const DAY_MS = 24 * 60 * 60 * 1000;
const STATUS_POLL_MS = 30_000;

function localMidnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Next local midnight, robust across DST shifts (23/25-hour days).
function nextMidnight(dayStartMs: number): number {
  return localMidnight(dayStartMs + DAY_MS + DAY_MS / 2);
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function fmtAgo(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

interface SelectedProgram {
  program: EpgProgram;
  channelName: string;
}

export function EpgGuide() {
  const [providers, setProviders] = useState<EffectiveProvider[] | "loading" | "error">("loading");
  const [providerId, setProviderId] = useState<number | null>(null);
  const [categories, setCategories] = useState<LiveCategory[] | "loading" | "error">("loading");
  const [categoryId, setCategoryId] = useState<string>("");
  const [channels, setChannels] = useState<LiveChannel[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [dayStartMs, setDayStartMs] = useState(() => localMidnight(Date.now()));
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
  const [promoted, setPromoted] = useState(false);
  const [settings, setSettings] = useState<PlayerSettings | "loading" | "error">("loading");
  const [timeoutInput, setTimeoutInput] = useState("");
  const [recorderMode, setRecorderMode] = useState(false);
  const [recordTarget, setRecordTarget] = useState<{ channel: LiveChannel; startMs: number; stopMs: number } | null>(null);

  const dayEndMs = nextMidnight(dayStartMs);
  const dayMinutes = (dayEndMs - dayStartMs) / 60_000;
  const contentWidth = CH_COL_W + dayMinutes * PX_PER_MIN;
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

  // Mini-player auto-close setting, once on mount — see Player.tsx's
  // `previewTimeoutSecs` comment for why this lives server-side as a user
  // setting rather than a constant.
  useEffect(() => {
    api
      .get<PlayerSettings>("/config/player")
      .then((s) => {
        setSettings(s);
        setTimeoutInput(String(s.previewTimeoutSecs));
      })
      .catch(() => setSettings("error"));
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

  // Categories on provider change.
  useEffect(() => {
    if (providerId === null) return;
    setCategories("loading");
    setCategoryId("");
    let current = true;
    api
      .get<LiveCategory[]>(`/providers/${providerId}/live/categories`)
      .then((result) => {
        if (current) setCategories(result);
      })
      .catch(() => {
        if (current) setCategories("error");
      });
    return () => {
      current = false;
    };
  }, [providerId]);

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

  const changeDay = (newDayStartMs: number) => {
    setDayStartMs(newDayStartMs);
    resetProgramCache();
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
    resetProgramCache();
    setBounds(null);
    refreshStatus(providerId);
    const timer = setInterval(() => {
      setNowMs(Date.now());
      refreshStatus(providerId);
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  // Fetch programs for visible rows (plus overscan) that aren't cached yet.
  useEffect(() => {
    if (providerId === null || visibleEnd < 0) return;
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
        .get<EpgProgram[]>(`/providers/${providerId}/epg/programs?channelIds=${ids.map(encodeURIComponent).join(",")}&from=${dayStartMs}&to=${dayEndMs}`)
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
  }, [providerId, visibleStart, visibleEnd, dayStartMs, dayEndMs, channels, programs]);

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

  const scrollToTime = (timeMs: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const minutes = (timeMs - dayStartMs) / 60_000;
    el.scrollLeft = Math.max(0, (minutes - 15) * PX_PER_MIN);
  };

  // Open the grid at the current time rather than 12:00 AM. Runs once
  // status first loads (the scroll container doesn't render until guide
  // data exists).
  const didInitialScrollRef = useRef(false);
  useEffect(() => {
    if (didInitialScrollRef.current || !scrollRef.current) return;
    didInitialScrollRef.current = true;
    scrollToTime(Date.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Apply a pending jump (from search or jump-to-now) once the target day is
  // the active day.
  useEffect(() => {
    if (!jumpTarget) return;
    if (localMidnight(jumpTarget.timeMs) !== dayStartMs) return;
    setJumpTarget(null);
    const rowIndex = channels.findIndex((c) => c.epgChannelId === jumpTarget.channelId);
    if (rowIndex >= 0) rowVirtualizer.scrollToIndex(rowIndex, { align: "center" });
    scrollToTime(jumpTarget.timeMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTarget, dayStartMs, channels]);

  const jumpToNow = () => {
    const now = Date.now();
    const today = localMidnight(now);
    if (today !== dayStartMs) changeDay(today);
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollLeft = Math.max(0, ((now - today) / 60_000 - 15) * PX_PER_MIN);
    });
  };

  // Starts/switches the permanent mini-player dock (PLAN.md "Guide-centric
  // Live TV") — only resets `promoted` when actually switching to a
  // different channel, so re-clicking the same channel's cell or another of
  // its program blocks doesn't shrink an already-expanded player back down.
  const startPreview = (channelId: string, name: string) => {
    if (previewChannel?.channelId !== channelId) {
      setPreviewChannel({ channelId, name });
      setPromoted(false);
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
    const day = localMidnight(result.startMs);
    if (day !== dayStartMs) changeDay(day);
    setJumpTarget({ channelId: result.channelId, timeMs: result.startMs });
    const channel = channelsByEpgId.get(result.channelId);
    if (channel) startPreview(channel.channelId, channel.name);
  };

  const saveTimeoutSetting = () => {
    const parsed = Number(timeoutInput);
    if (!Number.isFinite(parsed) || parsed < 5 || parsed > 300 || settings === "loading" || settings === "error") {
      if (settings !== "loading" && settings !== "error") setTimeoutInput(String(settings.previewTimeoutSecs));
      return;
    }
    api.put<PlayerSettings>("/config/player", { previewTimeoutSecs: Math.round(parsed) }).then(setSettings);
  };

  const minDay = bounds?.minStartMs != null ? localMidnight(bounds.minStartMs) : null;
  const maxDay = bounds?.maxStopMs != null ? localMidnight(bounds.maxStopMs - 1) : null;
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
  for (let m = 0; m < dayMinutes; m += 30) {
    const tickMs = dayStartMs + m * 60_000;
    ticks.push(
      <div key={m} className="epg-tick" style={{ left: CH_COL_W + m * PX_PER_MIN, width: 30 * PX_PER_MIN }}>
        {m % 60 === 0 ? fmtTime(tickMs) : ""}
      </div>,
    );
  }

  const nowInDay = nowMs >= dayStartMs && nowMs < dayEndMs;
  const nowLeft = CH_COL_W + ((nowMs - dayStartMs) / 60_000) * PX_PER_MIN;

  return (
    <div className="epg-root">
      <div className="epg-toolbar">
        <button onClick={() => changeDay(localMidnight(dayStartMs - DAY_MS / 2))} disabled={minDay != null && dayStartMs <= minDay}>
          ◀
        </button>
        <span className="epg-day-label">{fmtDay(dayStartMs)}</span>
        <button onClick={() => changeDay(dayEndMs)} disabled={maxDay != null && dayStartMs >= maxDay}>
          ▶
        </button>
        <button onClick={jumpToNow}>Now</button>
        {providers.length > 1 && (
          <select value={providerId ?? ""} onChange={(e) => setProviderId(Number(e.target.value))}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={categories === "loading" || categories === "error"}>
          <option value="">All categories</option>
          {categories !== "loading" &&
            categories !== "error" &&
            categories.map((c) => (
              <option key={c.categoryId} value={c.categoryId}>
                {c.categoryName}
              </option>
            ))}
        </select>
        <input className="epg-search-input" type="search" placeholder="Search channels, titles, descriptions…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
        <button onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        <label className="epg-timeout-label">
          Preview auto-close after
          <input type="number" min={5} max={300} className="epg-timeout-input" value={timeoutInput} onChange={(e) => setTimeoutInput(e.target.value)} onBlur={saveTimeoutSetting} />
          sec
        </label>
        <span className={`epg-status${status?.state === "error" ? " epg-status-error" : ""}`}>{statusText}</span>
      </div>

      <div className="epg-player-row">
        <div className="epg-player-dock">
          {previewChannel && providerId !== null ? (
            <Player
              providerId={providerId}
              kind="live"
              mediaId={previewChannel.channelId}
              channelName={previewChannel.name}
              compact={!promoted}
              previewTimeoutSecs={!promoted && settings !== "loading" && settings !== "error" ? settings.previewTimeoutSecs : null}
              onPromote={() => setPromoted(true)}
              onClose={() => {
                setPreviewChannel(null);
                setPromoted(false);
              }}
            />
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
        </div>
      </div>

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
              </div>
            </div>

            {nowInDay && <div className="epg-now-line" style={{ left: nowLeft, height: RULER_H + rowVirtualizer.getTotalSize() }} />}

            {virtualItems.map((vi) => {
              const channel = channels[vi.index];
              const progs = channel.epgChannelId ? programs.get(channel.epgChannelId) : undefined;
              const loaded = channel.epgChannelId != null && progs !== undefined;
              return (
                <div key={vi.key} className="epg-row" style={{ top: RULER_H + vi.start, height: vi.size, width: contentWidth }}>
                  <div className="epg-channel-cell" title={channel.name} onClick={() => selectChannelAndProgram(channel, liveProgramFor(channel))}>
                    {channel.streamIcon && <img src={channel.streamIcon} alt="" loading="lazy" />}
                    <span>{channel.name}</span>
                  </div>
                  {progs?.map((p) => {
                    const clampedStart = Math.max(p.startMs, dayStartMs);
                    const clampedStop = Math.min(p.stopMs, dayEndMs);
                    const left = CH_COL_W + ((clampedStart - dayStartMs) / 60_000) * PX_PER_MIN;
                    const width = Math.max(6, ((clampedStop - clampedStart) / 60_000) * PX_PER_MIN - 2);
                    const isSelected = selected?.program.id === p.id;
                    const isPast = p.stopMs <= nowMs;
                    return (
                      <div
                        key={p.id}
                        className={`epg-block${isSelected ? " epg-block-selected" : ""}${isPast ? " epg-block-past" : ""}`}
                        style={{ left, width }}
                        title={p.title}
                        onClick={() => selectChannelAndProgram(channel, p)}
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
