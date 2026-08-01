import { useEffect, useState } from "react";
import { api, type EffectiveProvider, type LiveCategory, type LiveChannel, type PlayerSettings } from "../api";
import { Player } from "./Player";
import "./vod.css";
import "./live.css";

// PLAN.md "Live TV preview" — replaces the old plain-list LiveChannels.tsx.
// Single click on a channel starts a small floating preview (a real HLS
// session, same as a full watch — there's no cheaper way to "peek" at a
// stream); a second click on the same row, the "▶ Watch" button on the
// dock, or clicking the preview video itself all promote it to a full-size
// player. An unpromoted preview auto-closes after previewTimeoutSecs (a
// user setting, see /config/player) — purely client-driven, see
// Player.tsx's own comment on why that doesn't need any server-side
// "preview" concept.
export function LiveTV() {
  const [providers, setProviders] = useState<EffectiveProvider[] | "loading" | "error">("loading");
  const [providerId, setProviderId] = useState<number | null>(null);

  const [categories, setCategories] = useState<LiveCategory[] | "loading" | "error">("loading");
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);

  const [channels, setChannels] = useState<LiveChannel[] | "loading" | "error">("loading");
  const [filterText, setFilterText] = useState("");
  const [searchScope, setSearchScope] = useState<"category" | "all">("category");

  const [allChannels, setAllChannels] = useState<LiveChannel[] | null>(null);
  const [allChannelsLoading, setAllChannelsLoading] = useState(false);
  const [allChannelsError, setAllChannelsError] = useState<string>();

  const [previewChannel, setPreviewChannel] = useState<{ channelId: string; name: string } | null>(null);
  const [promoted, setPromoted] = useState(false);

  const [settings, setSettings] = useState<PlayerSettings | "loading" | "error">("loading");
  const [timeoutInput, setTimeoutInput] = useState("");

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
    api
      .get<PlayerSettings>("/config/player")
      .then((s) => {
        setSettings(s);
        setTimeoutInput(String(s.previewTimeoutSecs));
      })
      .catch(() => setSettings("error"));
  }, []);

  useEffect(() => {
    if (providerId === null) return;
    setCategories("loading");
    setSelectedCategoryId(null);
    let current = true;
    api
      .get<LiveCategory[]>(`/providers/${providerId}/live/categories`)
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
    setChannels("loading");
    let current = true;
    api
      .get<LiveChannel[]>(`/providers/${providerId}/live/channels?categoryId=${encodeURIComponent(selectedCategoryId)}`)
      .then((items) => {
        if (current) setChannels(items);
      })
      .catch(() => {
        if (current) setChannels("error");
      });
    return () => {
      current = false;
    };
  }, [providerId, selectedCategoryId]);

  const text = filterText.trim().toLowerCase();
  const searchingAll = Boolean(text) && searchScope === "all";

  // Same lazy-load-the-whole-library-only-when-searching-all pattern as
  // VodBrowser/SeriesBrowser — a real account's channel count is smaller
  // than a VOD library, but there's no reason to pay for it by default.
  useEffect(() => {
    if (providerId === null || !searchingAll || allChannels !== null || allChannelsLoading) return;
    let current = true;
    setAllChannelsLoading(true);
    setAllChannelsError(undefined);
    api
      .get<LiveChannel[]>(`/providers/${providerId}/live/channels`)
      .then((items) => {
        if (current) setAllChannels(items);
      })
      .catch((err) => {
        if (current) setAllChannelsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (current) setAllChannelsLoading(false);
      });
    return () => {
      current = false;
    };
    // Deliberately omits allChannels/allChannelsLoading — see VodBrowser's
    // identical comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, searchingAll]);

  const categoryNameById = new Map(categories !== "loading" && categories !== "error" ? categories.map((c) => [c.categoryId, c.categoryName]) : []);

  const baseList = channels === "loading" || channels === "error" ? [] : channels;
  const visibleChannels = !text ? baseList : searchingAll ? (allChannels ?? []).filter((c) => c.name.toLowerCase().includes(text)) : baseList.filter((c) => c.name.toLowerCase().includes(text));

  function handleChannelClick(ch: LiveChannel) {
    if (previewChannel?.channelId === ch.channelId) {
      setPromoted(true);
    } else {
      setPreviewChannel({ channelId: ch.channelId, name: ch.name });
      setPromoted(false);
    }
  }

  function closePreview() {
    setPreviewChannel(null);
    setPromoted(false);
  }

  function saveTimeoutSetting() {
    const parsed = Number(timeoutInput);
    if (!Number.isFinite(parsed) || parsed < 5 || parsed > 300 || settings === "loading" || settings === "error") {
      if (settings !== "loading" && settings !== "error") setTimeoutInput(String(settings.previewTimeoutSecs));
      return;
    }
    api.put<PlayerSettings>("/config/player", { previewTimeoutSecs: Math.round(parsed) }).then(setSettings);
  }

  if (providers === "loading") return <p>Loading providers…</p>;
  if (providers === "error") return <p className="error">Could not load providers.</p>;
  if (providers.length === 0) return <p className="muted">No providers configured yet.</p>;

  return (
    <section className="page">
      <div className="page-header">
        <h2>Live TV</h2>
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

      <div className="live-settings-row">
        <label className="live-timeout-label">
          Preview auto-close after
          <input
            type="number"
            min={5}
            max={300}
            className="live-timeout-input"
            value={timeoutInput}
            onChange={(e) => setTimeoutInput(e.target.value)}
            onBlur={saveTimeoutSetting}
          />
          sec
        </label>
      </div>

      {previewChannel && providerId !== null && (
        <Player
          providerId={providerId}
          kind="live"
          mediaId={previewChannel.channelId}
          channelName={previewChannel.name}
          compact={!promoted}
          previewTimeoutSecs={!promoted && settings !== "loading" && settings !== "error" ? settings.previewTimeoutSecs : null}
          onPromote={() => setPromoted(true)}
          onClose={closePreview}
        />
      )}

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
            <input className="vod-search" type="search" placeholder="Filter channels…" value={filterText} onChange={(e) => setFilterText(e.target.value)} />
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

          {channels === "loading" ? (
            <p className="muted" style={{ padding: 14 }}>
              Loading channels…
            </p>
          ) : channels === "error" ? (
            <p className="error" style={{ padding: 14 }}>
              Failed to load channels.
            </p>
          ) : searchingAll && allChannelsLoading ? (
            <p className="muted" style={{ padding: 14 }}>
              Loading full channel list…
            </p>
          ) : searchingAll && allChannelsError ? (
            <p className="error" style={{ padding: 14 }}>
              Failed to load full channel list: {allChannelsError}
            </p>
          ) : visibleChannels.length === 0 ? (
            <p className="muted" style={{ padding: 14 }}>
              No channels match.
            </p>
          ) : (
            <div className="live-channel-list">
              {visibleChannels.map((ch) => (
                <div
                  key={ch.channelId}
                  className={`live-channel-row${previewChannel?.channelId === ch.channelId ? " previewing" : ""}`}
                  onClick={() => handleChannelClick(ch)}
                >
                  {ch.streamIcon ? (
                    <img className="live-channel-icon" src={ch.streamIcon} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
                  ) : (
                    <div className="live-channel-icon live-channel-icon-fallback">{ch.name.charAt(0).toUpperCase()}</div>
                  )}
                  <span className="live-channel-name">{ch.name}</span>
                  {searchingAll && <span className="live-channel-category">{categoryNameById.get(ch.categoryId ?? "") ?? ""}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
