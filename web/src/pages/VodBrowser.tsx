import { useEffect, useState } from "react";
import { api, proxiedImageUrl, type EffectiveProvider, type Progress, type VodCategory, type VodInfo, type VodStream } from "../api";
import { getLastCategory, setLastCategory } from "../localSettings";
import { Player } from "./Player";
import "./vod.css";

// Ported from Laomedeia (src/components/VodBrowser.tsx) — same category
// sidebar + poster grid + "search this category vs. search all" scope
// toggle + detail modal shape, now with resume/watch-progress tracking
// wired up (PLAN.md — this was dropped when VOD first shipped for not
// having a progress store yet; ../progress.ts on the server now has one).
// Provider is still fetched independently rather than lifted from shared
// app state — same standalone pattern as LiveChannels.tsx/EpgGuide.tsx,
// including the same stale-response guard on every fetch (a real bug found
// and fixed once already — see PLAN.md "Live TV channel browsing" — applied
// consistently from the start here).
function formatResumeTime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function VodBrowser() {
  const [providers, setProviders] = useState<EffectiveProvider[] | "loading" | "error">("loading");
  const [providerId, setProviderId] = useState<number | null>(null);

  const [categories, setCategories] = useState<VodCategory[] | "loading" | "error">("loading");
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);

  const [streams, setStreams] = useState<VodStream[] | "loading" | "error">("loading");
  const [filterText, setFilterText] = useState("");
  const [searchScope, setSearchScope] = useState<"category" | "all">("category");

  const [allStreams, setAllStreams] = useState<VodStream[] | null>(null);
  const [allStreamsLoading, setAllStreamsLoading] = useState(false);
  const [allStreamsError, setAllStreamsError] = useState<string>();

  const [selectedItem, setSelectedItem] = useState<VodStream | null>(null);
  const [info, setInfo] = useState<VodInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [playing, setPlaying] = useState<{ item: VodStream; startPositionSecs?: number } | null>(null);

  useEffect(() => {
    api
      .get<EffectiveProvider[]>("/effective-providers")
      .then((list) => {
        setProviders(list);
        if (list.length > 0) setProviderId(list[0].id);
      })
      .catch(() => setProviders("error"));
  }, []);

  useEffect(() => {
    if (providerId === null) return;
    setCategories("loading");
    setSelectedCategoryId(null);
    let current = true;
    api
      .get<VodCategory[]>(`/providers/${providerId}/vod/categories`)
      .then((cats) => {
        if (!current) return;
        setCategories(cats);
        // Restores the last category chosen on this screen (PLAN.md
        // "Persisted UI settings") if it still exists; otherwise falls back
        // to the first category, same as before persistence existed.
        const stored = getLastCategory("vod");
        const restored = stored && cats.some((c) => c.categoryId === stored) ? stored : cats[0]?.categoryId;
        if (restored) setSelectedCategoryId(restored);
      })
      .catch(() => {
        if (current) setCategories("error");
      });
    return () => {
      current = false;
    };
  }, [providerId]);

  useEffect(() => {
    if (providerId === null || !selectedCategoryId) return;
    setStreams("loading");
    let current = true;
    api
      .get<VodStream[]>(`/providers/${providerId}/vod/streams?categoryId=${encodeURIComponent(selectedCategoryId)}`)
      .then((items) => {
        if (current) setStreams(items);
      })
      .catch(() => {
        if (current) setStreams("error");
      });
    return () => {
      current = false;
    };
  }, [providerId, selectedCategoryId]);

  useEffect(() => {
    if (!selectedItem || providerId === null) {
      setInfo(null);
      return;
    }
    let current = true;
    setInfoLoading(true);
    api
      .get<VodInfo>(`/providers/${providerId}/vod/streams/${selectedItem.streamId}`)
      .then((result) => {
        if (current) setInfo(result);
      })
      .catch(() => {
        if (current) setInfo(null);
      })
      .finally(() => {
        if (current) setInfoLoading(false);
      });
    return () => {
      current = false;
    };
  }, [providerId, selectedItem]);

  useEffect(() => {
    if (!selectedItem || providerId === null) {
      setProgress(null);
      return;
    }
    let current = true;
    api
      .get<Progress>(`/providers/${providerId}/progress/vod/${selectedItem.streamId}`)
      .then((result) => {
        if (current) setProgress(result);
      })
      .catch(() => {
        if (current) setProgress(null);
      });
    return () => {
      current = false;
    };
  }, [providerId, selectedItem]);

  const text = filterText.trim().toLowerCase();
  const searchingAll = Boolean(text) && searchScope === "all";

  // Lazy-loads the whole library only when the user actually searches with
  // scope=all — a real account's full VOD library can run in the tens of
  // thousands of titles (see PLAN.md), not worth fetching by default.
  useEffect(() => {
    if (providerId === null || !searchingAll || allStreams !== null || allStreamsLoading) return;
    let current = true;
    setAllStreamsLoading(true);
    setAllStreamsError(undefined);
    api
      .get<VodStream[]>(`/providers/${providerId}/vod/streams`)
      .then((items) => {
        if (current) setAllStreams(items);
      })
      .catch((err) => {
        if (current) setAllStreamsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (current) setAllStreamsLoading(false);
      });
    return () => {
      current = false;
    };
    // Deliberately omits allStreams/allStreamsLoading — see Laomedeia's own
    // identical comment: setAllStreamsLoading(true) would otherwise
    // retrigger this effect and cancel its own in-flight request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, searchingAll]);

  const categoryNameById = new Map(categories !== "loading" && categories !== "error" ? categories.map((c) => [c.categoryId, c.categoryName]) : []);

  const baseList = streams === "loading" || streams === "error" ? [] : streams;
  const visibleStreams = !text ? baseList : searchingAll ? (allStreams ?? []).filter((s) => s.name.toLowerCase().includes(text)) : baseList.filter((s) => s.name.toLowerCase().includes(text));

  if (providers === "loading") return <p>Loading providers…</p>;
  if (providers === "error") return <p className="error">Could not load providers.</p>;
  if (providers.length === 0) return <p className="muted">No providers configured yet.</p>;

  return (
    <section className="page">
      <div className="page-header">
        <h2>Movies</h2>
        {providers.length > 1 && (
          <select value={providerId ?? ""} onChange={(e) => setProviderId(Number(e.target.value))}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="vod-panel">
        <aside className="vod-sidebar">
          {categories === "loading" ? (
            <p className="muted" style={{ padding: 14 }}>
              Loading categories…
            </p>
          ) : categories === "error" ? (
            <p className="error" style={{ padding: 14 }}>
              Failed to load categories.
            </p>
          ) : (
            <div className="vod-category-list">
              {categories.map((cat) => (
                <div
                  key={cat.categoryId}
                  className={`vod-category-row${cat.categoryId === selectedCategoryId ? " selected" : ""}`}
                  onClick={() => {
                    setSelectedCategoryId(cat.categoryId);
                    setLastCategory("vod", cat.categoryId);
                  }}
                >
                  {cat.categoryName}
                </div>
              ))}
            </div>
          )}
        </aside>

        <div className="vod-main">
          <div className="vod-toolbar">
            <input className="vod-search" type="search" placeholder="Filter titles…" value={filterText} onChange={(e) => setFilterText(e.target.value)} />
            {text && (
              <div className="vod-scope-toggle">
                <button type="button" className={`vod-scope-btn${searchScope === "category" ? " active" : ""}`} onClick={() => setSearchScope("category")}>
                  This category
                </button>
                <button type="button" className={`vod-scope-btn${searchScope === "all" ? " active" : ""}`} onClick={() => setSearchScope("all")}>
                  All
                </button>
              </div>
            )}
          </div>

          {streams === "loading" ? (
            <p className="muted" style={{ padding: 14 }}>
              Loading titles…
            </p>
          ) : streams === "error" ? (
            <p className="error" style={{ padding: 14 }}>
              Failed to load titles.
            </p>
          ) : searchingAll && allStreamsLoading ? (
            <p className="muted" style={{ padding: 14 }}>
              Loading full library…
            </p>
          ) : searchingAll && allStreamsError ? (
            <p className="error" style={{ padding: 14 }}>
              Failed to load full library: {allStreamsError}
            </p>
          ) : visibleStreams.length === 0 ? (
            <p className="muted" style={{ padding: 14 }}>
              No titles match.
            </p>
          ) : (
            <div className="vod-grid">
              {visibleStreams.map((item) => (
                <div key={item.streamId} className="vod-poster-card" onClick={() => setSelectedItem(item)}>
                  {item.streamIcon ? (
                    <img className="vod-poster-img" src={proxiedImageUrl(item.streamIcon)} alt="" loading="lazy" />
                  ) : (
                    <div className="vod-poster-img vod-poster-fallback">{item.name.charAt(0).toUpperCase()}</div>
                  )}
                  <div className="vod-poster-title" title={item.name}>
                    {item.name}
                  </div>
                  {searchingAll && <div className="vod-poster-category">{categoryNameById.get(item.categoryId) ?? ""}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {selectedItem && (
        <div className="vod-detail-backdrop" onClick={() => setSelectedItem(null)}>
          <div className="vod-detail-card" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="vod-detail-close" onClick={() => setSelectedItem(null)}>
              ✕
            </button>
            {selectedItem.streamIcon ? (
              <img className="vod-detail-poster" src={proxiedImageUrl(selectedItem.streamIcon)} alt="" />
            ) : (
              <div className="vod-detail-poster vod-poster-fallback">{selectedItem.name.charAt(0).toUpperCase()}</div>
            )}
            <div className="vod-detail-info">
              <h2 className="vod-detail-title">{selectedItem.name}</h2>
              {infoLoading ? (
                <p className="muted">Loading details…</p>
              ) : (
                <>
                  <div className="vod-detail-meta">
                    {(info?.rating ?? selectedItem.rating) != null && <span>★ {(info?.rating ?? selectedItem.rating)?.toFixed(1)}</span>}
                    {info?.releaseDate && <span>{info.releaseDate.slice(0, 4)}</span>}
                    {info?.genre && <span>{info.genre}</span>}
                  </div>
                  {info?.plot && <p className="vod-detail-plot">{info.plot}</p>}
                  {info?.cast && (
                    <p className="vod-detail-cast">
                      <strong>Cast:</strong> {info.cast}
                    </p>
                  )}
                  {info?.director && (
                    <p className="vod-detail-cast">
                      <strong>Director:</strong> {info.director}
                    </p>
                  )}
                </>
              )}
              <div className="vod-detail-actions">
                {progress ? (
                  <>
                    <button
                      onClick={() => {
                        setPlaying({ item: selectedItem, startPositionSecs: progress.positionSecs });
                        setSelectedItem(null);
                      }}
                    >
                      ▶ Resume at {formatResumeTime(progress.positionSecs)}
                    </button>
                    <button
                      className="button-link"
                      onClick={() => {
                        setPlaying({ item: selectedItem });
                        setSelectedItem(null);
                      }}
                    >
                      Play from start
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => {
                      setPlaying({ item: selectedItem });
                      setSelectedItem(null);
                    }}
                  >
                    ▶ Play
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {playing && providerId !== null && (
        <Player
          providerId={providerId}
          kind="vod"
          mediaId={String(playing.item.streamId)}
          containerExtension={playing.item.containerExtension}
          startPositionSecs={playing.startPositionSecs}
          channelName={playing.item.name}
          onClose={() => setPlaying(null)}
        />
      )}
    </section>
  );
}
