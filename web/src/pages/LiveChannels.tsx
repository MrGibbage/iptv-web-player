import { useEffect, useState } from "react";
import { api, type EffectiveProvider, type LiveCategory, type LiveChannel } from "../api";
import { Player } from "./Player";

// PLAN.md "Live TV channel browsing" — category filter + channel list
// against whichever provider source is active, plus a "Watch" action that
// starts an HLS playback session (see ./Player.tsx and PLAN.md "Playback
// architecture").
export function LiveChannels() {
  const [providers, setProviders] = useState<EffectiveProvider[] | "loading" | "error">("loading");
  const [providerId, setProviderId] = useState<number | null>(null);
  const [categories, setCategories] = useState<LiveCategory[] | "loading" | "error">("loading");
  const [categoryId, setCategoryId] = useState<string>("");
  const [channels, setChannels] = useState<LiveChannel[] | "loading" | "error">("loading");
  const [playing, setPlaying] = useState<{ channelId: string; name: string } | null>(null);

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

  useEffect(() => {
    if (providerId === null) return;
    setChannels("loading");
    // "All categories" can be a much larger response than a single category
    // and take longer to resolve — without this guard, switching categories
    // while that request is still in flight lets it land *after* the
    // filtered one and silently overwrite the correct result with the stale
    // unfiltered list (found via a real browser test: the dropdown showed
    // the selected category, but the list rendered was the full unfiltered
    // one). `current` makes a superseded request's response a no-op.
    let current = true;
    const query = categoryId ? `?categoryId=${encodeURIComponent(categoryId)}` : "";
    api
      .get<LiveChannel[]>(`/providers/${providerId}/live/channels${query}`)
      .then((result) => {
        if (current) setChannels(result);
      })
      .catch(() => {
        if (current) setChannels("error");
      });
    return () => {
      current = false;
    };
  }, [providerId, categoryId]);

  if (providers === "loading") return <p>Loading providers…</p>;
  if (providers === "error") return <p className="error">Could not load providers.</p>;
  if (providers.length === 0) return <p className="muted">No providers configured yet.</p>;

  return (
    <section className="page">
      <h2>Live TV</h2>
      <div className="form" style={{ flexDirection: "row", alignItems: "flex-end", gap: 16 }}>
        {providers.length > 1 && (
          <label>
            Provider
            <select value={providerId ?? ""} onChange={(e) => setProviderId(Number(e.target.value))}>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Category
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={categories === "loading" || categories === "error"}>
            <option value="">All categories</option>
            {categories !== "loading" && categories !== "error" && categories.map((c) => (
              <option key={c.categoryId} value={c.categoryId}>
                {c.categoryName}
              </option>
            ))}
          </select>
        </label>
      </div>

      {playing && providerId !== null && (
        <Player providerId={providerId} channelId={playing.channelId} channelName={playing.name} onClose={() => setPlaying(null)} />
      )}

      {categories === "error" && <p className="error">Could not load categories.</p>}

      {channels === "loading" && <p>Loading channels…</p>}
      {channels === "error" && <p className="error">Could not load channels.</p>}
      {channels !== "loading" && channels !== "error" && (
        <>
          <p className="muted">{channels.length} channel{channels.length === 1 ? "" : "s"}</p>
          <ul>
            {channels.map((ch) => (
              <li key={ch.channelId}>
                {ch.streamIcon && (
                  <img src={ch.streamIcon} alt="" width={20} height={20} style={{ verticalAlign: "middle", marginRight: 8 }} onError={(e) => (e.currentTarget.style.display = "none")} />
                )}
                {ch.name}{" "}
                <button type="button" className="button-link" onClick={() => setPlaying({ channelId: ch.channelId, name: ch.name })}>
                  Watch
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
