import { useEffect, useState } from "react";
import { api, type EffectiveProvider, type SeriesCategory, type SeriesEpisode, type SeriesInfo, type SeriesListItem } from "../api";
import { Player } from "./Player";
import "./vod.css";
import "./series.css";

// Ported from Laomedeia (src/components/SeriesBrowser.tsx) — reuses the
// exact same shape as VodBrowser.tsx (category sidebar, poster grid,
// category-vs-all search scope), plus a season-tabs + episode-list layer
// once a show is opened. Same standalone/stale-response-guard pattern as
// every other browsing page here; same drop of resume/watch-progress
// tracking (no progress store built yet).
export function SeriesBrowser() {
  const [providers, setProviders] = useState<EffectiveProvider[] | "loading" | "error">("loading");
  const [providerId, setProviderId] = useState<number | null>(null);

  const [categories, setCategories] = useState<SeriesCategory[] | "loading" | "error">("loading");
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);

  const [seriesList, setSeriesList] = useState<SeriesListItem[] | "loading" | "error">("loading");
  const [filterText, setFilterText] = useState("");
  const [searchScope, setSearchScope] = useState<"category" | "all">("category");

  const [allSeries, setAllSeries] = useState<SeriesListItem[] | null>(null);
  const [allSeriesLoading, setAllSeriesLoading] = useState(false);
  const [allSeriesError, setAllSeriesError] = useState<string>();

  const [selectedSeries, setSelectedSeries] = useState<SeriesListItem | null>(null);
  const [info, setInfo] = useState<SeriesInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  const [playing, setPlaying] = useState<{ episode: SeriesEpisode; seriesName: string } | null>(null);

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
      .get<SeriesCategory[]>(`/providers/${providerId}/series/categories`)
      .then((cats) => {
        if (!current) return;
        setCategories(cats);
        if (cats.length > 0) setSelectedCategoryId(cats[0].categoryId);
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
    setSeriesList("loading");
    let current = true;
    api
      .get<SeriesListItem[]>(`/providers/${providerId}/series/list?categoryId=${encodeURIComponent(selectedCategoryId)}`)
      .then((items) => {
        if (current) setSeriesList(items);
      })
      .catch(() => {
        if (current) setSeriesList("error");
      });
    return () => {
      current = false;
    };
  }, [providerId, selectedCategoryId]);

  useEffect(() => {
    if (!selectedSeries || providerId === null) {
      setInfo(null);
      setSelectedSeason(null);
      return;
    }
    let current = true;
    setInfoLoading(true);
    api
      .get<SeriesInfo>(`/providers/${providerId}/series/list/${selectedSeries.seriesId}`)
      .then((result) => {
        if (!current) return;
        setInfo(result);
        setSelectedSeason(result.seasons[0]?.seasonNumber ?? null);
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
  }, [providerId, selectedSeries]);

  const text = filterText.trim().toLowerCase();
  const searchingAll = Boolean(text) && searchScope === "all";

  useEffect(() => {
    if (providerId === null || !searchingAll || allSeries !== null || allSeriesLoading) return;
    let current = true;
    setAllSeriesLoading(true);
    setAllSeriesError(undefined);
    api
      .get<SeriesListItem[]>(`/providers/${providerId}/series/list`)
      .then((items) => {
        if (current) setAllSeries(items);
      })
      .catch((err) => {
        if (current) setAllSeriesError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (current) setAllSeriesLoading(false);
      });
    return () => {
      current = false;
    };
    // Deliberately omits allSeries/allSeriesLoading — see VodBrowser.tsx's
    // identical comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, searchingAll]);

  const categoryNameById = new Map(categories !== "loading" && categories !== "error" ? categories.map((c) => [c.categoryId, c.categoryName]) : []);

  const baseList = seriesList === "loading" || seriesList === "error" ? [] : seriesList;
  const visibleSeries = !text ? baseList : searchingAll ? (allSeries ?? []).filter((s) => s.name.toLowerCase().includes(text)) : baseList.filter((s) => s.name.toLowerCase().includes(text));

  const season = info?.seasons.find((s) => s.seasonNumber === selectedSeason);

  if (providers === "loading") return <p>Loading providers…</p>;
  if (providers === "error") return <p className="error">Could not load providers.</p>;
  if (providers.length === 0) return <p className="muted">No providers configured yet.</p>;

  return (
    <section className="page">
      <div className="page-header">
        <h2>TV Shows</h2>
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
                <div key={cat.categoryId} className={`vod-category-row${cat.categoryId === selectedCategoryId ? " selected" : ""}`} onClick={() => setSelectedCategoryId(cat.categoryId)}>
                  {cat.categoryName}
                </div>
              ))}
            </div>
          )}
        </aside>

        <div className="vod-main">
          <div className="vod-toolbar">
            <input className="vod-search" type="search" placeholder="Filter shows…" value={filterText} onChange={(e) => setFilterText(e.target.value)} />
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

          {seriesList === "loading" ? (
            <p className="muted" style={{ padding: 14 }}>
              Loading shows…
            </p>
          ) : seriesList === "error" ? (
            <p className="error" style={{ padding: 14 }}>
              Failed to load shows.
            </p>
          ) : searchingAll && allSeriesLoading ? (
            <p className="muted" style={{ padding: 14 }}>
              Loading full library…
            </p>
          ) : searchingAll && allSeriesError ? (
            <p className="error" style={{ padding: 14 }}>
              Failed to load full library: {allSeriesError}
            </p>
          ) : visibleSeries.length === 0 ? (
            <p className="muted" style={{ padding: 14 }}>
              No shows match.
            </p>
          ) : (
            <div className="vod-grid">
              {visibleSeries.map((item) => (
                <div key={item.seriesId} className="vod-poster-card" onClick={() => setSelectedSeries(item)}>
                  {item.cover ? (
                    <img className="vod-poster-img" src={item.cover} alt="" loading="lazy" />
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

      {selectedSeries && (
        <div className="vod-detail-backdrop" onClick={() => setSelectedSeries(null)}>
          <div className="vod-detail-card series-detail-card" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="vod-detail-close" onClick={() => setSelectedSeries(null)}>
              ✕
            </button>
            {selectedSeries.cover ? (
              <img className="vod-detail-poster" src={selectedSeries.cover} alt="" />
            ) : (
              <div className="vod-detail-poster vod-poster-fallback">{selectedSeries.name.charAt(0).toUpperCase()}</div>
            )}
            <div className="vod-detail-info">
              <h2 className="vod-detail-title">{selectedSeries.name}</h2>
              {infoLoading ? (
                <p className="muted">Loading details…</p>
              ) : (
                <>
                  <div className="vod-detail-meta">
                    {(info?.rating ?? selectedSeries.rating) != null && <span>★ {(info?.rating ?? selectedSeries.rating)?.toFixed(1)}</span>}
                    {info?.releaseDate && <span>{info.releaseDate.slice(0, 4)}</span>}
                    {info?.genre && <span>{info.genre}</span>}
                  </div>
                  {info?.plot && <p className="vod-detail-plot">{info.plot}</p>}
                  {info?.cast && (
                    <p className="vod-detail-cast">
                      <strong>Cast:</strong> {info.cast}
                    </p>
                  )}

                  {info && info.seasons.length === 0 && <p className="muted" style={{ marginTop: 16 }}>No episodes available — the provider hasn't listed any for this title.</p>}

                  {info && info.seasons.length > 0 && (
                    <>
                      <div className="series-season-tabs">
                        {info.seasons.map((s) => (
                          <button key={s.seasonNumber} type="button" className={`series-season-tab${s.seasonNumber === selectedSeason ? " active" : ""}`} onClick={() => setSelectedSeason(s.seasonNumber)}>
                            {s.name || `Season ${s.seasonNumber}`}
                          </button>
                        ))}
                      </div>

                      <div className="series-episode-list">
                        {season?.episodes.map((ep) => (
                          <div key={ep.id} className="series-episode-row">
                            <div className="series-episode-main">
                              <span className="series-episode-num">{ep.episodeNum}.</span>
                              <span className="series-episode-title" title={ep.title}>
                                {ep.title}
                              </span>
                              {ep.duration && <span className="series-episode-duration">{ep.duration}</span>}
                            </div>
                            <div className="series-episode-actions">
                              <button
                                type="button"
                                onClick={() => {
                                  setPlaying({ episode: ep, seriesName: selectedSeries.name });
                                  setSelectedSeries(null);
                                }}
                              >
                                ▶ Play
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {playing && providerId !== null && (
        <Player
          providerId={providerId}
          kind="series"
          mediaId={playing.episode.id}
          containerExtension={playing.episode.containerExtension}
          channelName={`${playing.seriesName} — ${playing.episode.title}`}
          onClose={() => setPlaying(null)}
        />
      )}
    </section>
  );
}
