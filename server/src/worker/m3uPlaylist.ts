// Ported from iptv-scheduler (server/src/epg/m3u.ts) — same parser, same
// channel-identity convention: unlike Xtream, an M3U playlist has no
// {base + credentials + id} template to reconstruct a stream URL from, so a
// channel's `channelId` here *is* its resolved stream URL, not a synthetic
// id. Deliberately tolerant of malformed entries (a URL line with no
// preceding #EXTINF, or vice versa) — this is real provider-authored data,
// not a controlled fixture.

export type M3uChannel = {
  channelId: string;
  name: string;
  // tvg-id — matched against the XMLTV <channel id> attribute from a
  // provider's epgUrl, same role as Xtream's epg_channel_id.
  epgChannelId: string | null;
  // group-title — the category name directly, unlike Xtream where
  // categoryId needs a second get_live_categories lookup to become a name.
  category: string | null;
};

const EXTINF_ATTR = /([a-zA-Z0-9_-]+)="([^"]*)"/g;

function parseExtinfAttrs(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of line.matchAll(EXTINF_ATTR)) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

// Display name is whatever follows the last comma on the #EXTINF line
// (standard M3U convention — everything before it is duration + attrs).
function parseDisplayName(line: string): string {
  const idx = line.lastIndexOf(",");
  return idx === -1 ? "" : line.slice(idx + 1).trim();
}

export function parseM3uPlaylist(text: string): M3uChannel[] {
  const lines = text.split(/\r?\n/);
  const channels: M3uChannel[] = [];
  let pending: { name: string; epgChannelId: string | null; category: string | null } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    if (line.startsWith("#EXTINF")) {
      const attrs = parseExtinfAttrs(line);
      pending = {
        name: attrs["tvg-name"] || parseDisplayName(line) || "Unnamed channel",
        epgChannelId: attrs["tvg-id"] || null,
        category: attrs["group-title"] || null,
      };
      continue;
    }

    if (line.startsWith("#")) continue; // other directives (#EXTM3U, #EXTGRP, ...) carry nothing this app uses

    if (pending) {
      channels.push({ channelId: line, ...pending });
      pending = null;
    }
    // a bare URL with no preceding #EXTINF is dropped — see file comment above
  }

  return channels;
}

// Plain unauthenticated GET — an m3u playlistUrl already embeds whatever
// credentials it needs in the URL itself, so there's no separate auth step
// the way Xtream's username/password query params are.
export async function fetchM3uPlaylist(playlistUrl: string): Promise<string> {
  const response = await fetch(playlistUrl);
  if (!response.ok) {
    throw new Error(`m3u playlist fetch returned ${response.status}`);
  }
  return response.text();
}
