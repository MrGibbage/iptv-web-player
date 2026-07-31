import { getEffectiveProviderConnection } from "./providerSource.js";
import { getLiveCategories, getLiveStreams } from "./worker/xtreamLive.js";
import { fetchM3uPlaylist, parseM3uPlaylist } from "./worker/m3uPlaylist.js";

// Unifies Xtream's category/stream API and M3U's flat playlist behind one
// shape, so a browsing UI never needs to know which provider type it's
// looking at. Xtream has a real categoryId/categoryName pair from its own
// endpoint; M3U has no such thing — group-title *is* the category name, so
// its categoryId and categoryName are just the same string.

export type LiveCategory = {
  categoryId: string;
  categoryName: string;
};

export type LiveChannel = {
  // Xtream: stream_id as a string. M3U: the channel's resolved stream URL
  // (see ../worker/m3uPlaylist.ts) — there's no synthetic id to use instead.
  channelId: string;
  name: string;
  streamIcon: string | null;
  categoryId: string | null;
  epgChannelId: string | null;
};

export async function listLiveCategories(providerId: number): Promise<LiveCategory[]> {
  const connection = await getEffectiveProviderConnection(providerId);
  if (connection.type === "xtream") {
    const categories = await getLiveCategories(connection);
    return categories;
  }

  // M3U: no category endpoint — derive the distinct group-title values from
  // the playlist itself, in first-seen order. This re-parses the whole
  // playlist on every call (no caching yet); acceptable for now, worth
  // revisiting if playlists prove large enough to make repeated browsing
  // feel slow.
  const text = await fetchM3uPlaylist(connection.playlistUrl);
  const channels = parseM3uPlaylist(text);
  const seen = new Set<string>();
  const categories: LiveCategory[] = [];
  for (const ch of channels) {
    if (ch.category && !seen.has(ch.category)) {
      seen.add(ch.category);
      categories.push({ categoryId: ch.category, categoryName: ch.category });
    }
  }
  return categories;
}

export async function listLiveChannels(providerId: number, categoryId?: string): Promise<LiveChannel[]> {
  const connection = await getEffectiveProviderConnection(providerId);
  if (connection.type === "xtream") {
    const streams = await getLiveStreams(connection, categoryId);
    return streams.map((s) => ({
      channelId: String(s.streamId),
      name: s.name,
      streamIcon: s.streamIcon || null,
      categoryId: s.categoryId || null,
      epgChannelId: s.epgChannelId,
    }));
  }

  const text = await fetchM3uPlaylist(connection.playlistUrl);
  const channels = parseM3uPlaylist(text);
  const filtered = categoryId ? channels.filter((ch) => ch.category === categoryId) : channels;
  return filtered.map((ch) => ({
    channelId: ch.channelId,
    name: ch.name,
    streamIcon: null,
    categoryId: ch.category,
    epgChannelId: ch.epgChannelId,
  }));
}
