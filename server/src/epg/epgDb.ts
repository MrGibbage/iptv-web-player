import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

// Ported from Laomedeia (electron/epg-db.ts) — same staging-swap/FTS5 design,
// proven at guide-rendering scale (thousands of channels, 100k+ programs).
// The only real change is the storage location: Electron's per-user
// `userData` directory becomes a plain data directory here (PLAN.md "EPG
// ingestion").
//
// `providerKey` (was `providerId` in Laomedeia, a single-account app) is a
// caller-supplied cache-key string, not a raw numeric provider id — see
// ../providerSource.ts's `providerCacheKey()`, which namespaces it by
// provider-source mode (`recorder-3` vs `local-3`) so switching modes can
// never confuse one provider's cache for another's, even if the two id
// spaces happen to collide numerically.

const EPG_DATA_DIR = process.env.EPG_DATA_DIR ?? "./data/epg";

export interface EpgChannel {
  id: string;
  displayName: string;
  icon: string | null;
}

export interface EpgProgram {
  id: number;
  channelId: string;
  startMs: number;
  stopMs: number;
  title: string;
  description: string;
}

export interface EpgSearchResult extends EpgProgram {
  channelName: string;
}

export interface EpgBounds {
  minStartMs: number | null;
  maxStopMs: number | null;
}

let currentProviderKey: string | null = null;
let db: Database.Database | null = null;

// Each provider gets its own cache file so channel IDs from one provider can
// never collide with another's — only one connection is kept open at a time,
// reopened against the requested provider's file when it differs from the
// currently-open one (this app refreshes providers one at a time in a loop,
// see ../epg/index.ts, so that's the only access pattern that matters).
function getDb(providerKey: string): Database.Database {
  if (db && currentProviderKey === providerKey) return db;
  if (db) db.close();
  currentProviderKey = providerKey;
  mkdirSync(EPG_DATA_DIR, { recursive: true });
  const file = path.join(EPG_DATA_DIR, `epg-cache-${providerKey}.sqlite3`);
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS epg_channels (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      icon TEXT
    );
    CREATE TABLE IF NOT EXISTS programs (
      id INTEGER PRIMARY KEY,
      channel_id TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      stop_ms INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_programs_channel_time
      ON programs (channel_id, start_ms);
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  createFtsTable(db);
  return db;
}

// Contentless FTS5 tables don't support DELETE, and a refresh replaces every
// row anyway, so each ingest builds a fresh FTS table in staging.
function createFtsTable(d: Database.Database): void {
  d.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS programs_fts
      USING fts5(title, description, channel_name, content='');
  `);
}

export function getMeta(providerKey: string, key: string): string | null {
  const row = getDb(providerKey).prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(providerKey: string, key: string, value: string): void {
  getDb(providerKey)
    .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

export interface IngestHandle {
  insertChannel(channel: Omit<EpgChannel, "id"> & { id: string }): void;
  insertProgram(p: {
    channelId: string;
    startMs: number;
    stopMs: number;
    title: string;
    description: string;
    channelName: string;
  }): void;
  commit(): void;
  rollback(): void;
}

// Begins a full-replace ingest. Rows are written to *_staging tables so the
// live tables stay fully readable (showing the previous guide) for the whole
// refresh; commit() swaps staging in atomically. The transaction is held open
// across async parser callbacks (better-sqlite3 statements are synchronous,
// so interleaved awaits between batches are safe on this single connection —
// reads in between see the untouched live tables). Callers MUST call commit()
// or rollback(); either way the transaction ends, so staging tables created
// inside it never survive a crash.
export function beginReplaceIngest(providerKey: string): IngestHandle {
  const d = getDb(providerKey);
  d.exec("BEGIN IMMEDIATE");
  try {
    d.exec(`
      DROP TABLE IF EXISTS epg_channels_staging;
      DROP TABLE IF EXISTS programs_staging;
      DROP TABLE IF EXISTS programs_fts_staging;
      CREATE TABLE epg_channels_staging (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        icon TEXT
      );
      CREATE TABLE programs_staging (
        id INTEGER PRIMARY KEY,
        channel_id TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        stop_ms INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT ''
      );
      CREATE VIRTUAL TABLE programs_fts_staging
        USING fts5(title, description, channel_name, content='');
    `);
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }

  const insChannel = d.prepare("INSERT OR REPLACE INTO epg_channels_staging (id, display_name, icon) VALUES (?, ?, ?)");
  const insProgram = d.prepare("INSERT INTO programs_staging (channel_id, start_ms, stop_ms, title, description) VALUES (?, ?, ?, ?, ?)");
  const insFts = d.prepare("INSERT INTO programs_fts_staging (rowid, title, description, channel_name) VALUES (?, ?, ?, ?)");

  let open = true;

  return {
    insertChannel(channel) {
      insChannel.run(channel.id, channel.displayName, channel.icon);
    },
    insertProgram(p) {
      const info = insProgram.run(p.channelId, p.startMs, p.stopMs, p.title, p.description);
      insFts.run(info.lastInsertRowid, p.title, p.description, p.channelName);
    },
    commit() {
      if (!open) return;
      open = false;
      try {
        // Atomic swap: the old guide disappears and the new one appears in
        // the same transaction. The channel+time index is rebuilt here
        // (bulk insert into an unindexed table + one index build is faster
        // than maintaining the index row-by-row).
        d.exec(`
          DROP TABLE epg_channels;
          DROP TABLE programs;
          DROP TABLE IF EXISTS programs_fts;
          ALTER TABLE epg_channels_staging RENAME TO epg_channels;
          ALTER TABLE programs_staging RENAME TO programs;
          ALTER TABLE programs_fts_staging RENAME TO programs_fts;
          CREATE INDEX idx_programs_channel_time ON programs (channel_id, start_ms);
          COMMIT;
        `);
      } catch (err) {
        d.exec("ROLLBACK");
        throw err;
      }
    },
    rollback() {
      if (!open) return;
      open = false;
      d.exec("ROLLBACK");
    },
  };
}

export function getPrograms(providerKey: string, channelIds: string[], fromMs: number, toMs: number): EpgProgram[] {
  if (channelIds.length === 0) return [];
  const placeholders = channelIds.map(() => "?").join(", ");
  const rows = getDb(providerKey)
    .prepare(
      `SELECT id, channel_id, start_ms, stop_ms, title, description
       FROM programs
       WHERE channel_id IN (${placeholders}) AND start_ms < ? AND stop_ms > ?
       ORDER BY channel_id, start_ms`,
    )
    .all(...channelIds, toMs, fromMs) as Array<{
    id: number;
    channel_id: string;
    start_ms: number;
    stop_ms: number;
    title: string;
    description: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    startMs: r.start_ms,
    stopMs: r.stop_ms,
    title: r.title,
    description: r.description,
  }));
}

// Turns free-text user input into an FTS5 prefix query: each whitespace-run-
// separated token becomes a quoted prefix term, ANDed together.
function buildFtsQuery(input: string): string | null {
  const tokens = input
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(" ");
}

// Search answers "what can I watch, now or later" — programs that already
// ended are excluded (still-airing ones stay in).
export function search(providerKey: string, query: string, limit = 200): EpgSearchResult[] {
  const match = buildFtsQuery(query);
  if (!match) return [];
  const rows = getDb(providerKey)
    .prepare(
      `SELECT p.id, p.channel_id, p.start_ms, p.stop_ms, p.title, p.description,
              COALESCE(c.display_name, p.channel_id) AS channel_name
       FROM programs_fts f
       JOIN programs p ON p.id = f.rowid
       LEFT JOIN epg_channels c ON c.id = p.channel_id
       WHERE programs_fts MATCH ? AND p.stop_ms > ?
       ORDER BY p.start_ms
       LIMIT ?`,
    )
    .all(match, Date.now(), limit) as Array<{
    id: number;
    channel_id: string;
    start_ms: number;
    stop_ms: number;
    title: string;
    description: string;
    channel_name: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    startMs: r.start_ms,
    stopMs: r.stop_ms,
    title: r.title,
    description: r.description,
    channelName: r.channel_name,
  }));
}

export function getBounds(providerKey: string): EpgBounds {
  const row = getDb(providerKey).prepare("SELECT MIN(start_ms) AS min_start, MAX(stop_ms) AS max_stop FROM programs").get() as {
    min_start: number | null;
    max_stop: number | null;
  };
  return { minStartMs: row.min_start, maxStopMs: row.max_stop };
}

export function getCounts(providerKey: string): { channels: number; programs: number } {
  const d = getDb(providerKey);
  const channels = (d.prepare("SELECT COUNT(*) AS n FROM epg_channels").get() as { n: number }).n;
  const programs = (d.prepare("SELECT COUNT(*) AS n FROM programs").get() as { n: number }).n;
  return { channels, programs };
}
