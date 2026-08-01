import { decrypt } from "./crypto.js";
import { getRecorderConfig } from "./db/settings.js";

// Thin HTTP client for iptv-recorder's API, used only when
// providerSourceConfig.mode = 'recorder' (see ../db/schema.ts). Mirrors
// iptv-scheduler's own recorderClient.ts and Laomedeia's electron/recorder.ts
// — this service is a client of iptv-recorder the same as any other, through
// its normal public surface only. Recording is entirely iptv-recorder's job
// (storage, retention, the actual DVR worker/scheduler) — this app only ever
// schedules/lists/cancels recordings and plays back a finished one; it never
// touches a recording file directly on disk (PLAN.md "sibling service, not
// an extension of").

export type RecorderProvider = {
  id: number;
  name: string;
  type: "xtream" | "m3u";
  baseUrl: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

// Mirrors iptv-recorder's own ProviderConnection (server/src/worker/
// providerShape.ts) and iptv-scheduler's copy of the same type.
export type XtreamConnection = { type: "xtream"; baseUrl: string; username: string; password: string };
export type M3uConnection = { type: "m3u"; playlistUrl: string; epgUrl: string | null };
export type ProviderConnection = XtreamConnection | M3uConnection;

export type RecordingStatus = "scheduled" | "recording" | "completed" | "failed" | "cancelled";

export type Recording = {
  id: number;
  providerId: number;
  channelId: string;
  recurringRuleId: number | null;
  startTime: string;
  endTime: string;
  status: RecordingStatus;
  filePath: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  projected?: boolean;
};

export type ProjectedOccurrence = {
  recurringRuleId: number;
  providerId: number;
  channelId: string;
  startTime: string;
  endTime: string;
  status: "scheduled";
  projected: true;
};

export type RecurringRule = {
  id: number;
  providerId: number;
  channelId: string;
  daysOfWeek: number;
  startMinuteOfDay: number;
  durationMinutes: number;
  endDate: string | null;
  maxOccurrences: number | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RecurringRuleCancelResult = RecurringRule & { cancelledRecordings: number };

export type SkipException = {
  id: number;
  ruleId: number;
  occurrenceDate: string;
  createdAt: string;
};

export type RecordingsFilter = {
  providerId?: number;
  channelId?: string;
  status?: RecordingStatus;
  startAfter?: string;
  startBefore?: string;
  recurringRuleId?: number;
  includeProjected?: boolean;
  profileId?: number;
};

export type RecurringRulesFilter = {
  providerId?: number;
  cancelled?: boolean;
  profileId?: number;
};

// PLAN.md "Profiles" — Netflix-profile-style attribution (iptv-recorder's
// own `profiles` table: no password, no auth boundary, see its
// server/src/routes/profiles.ts). This app only ever reads the list (to
// populate a "who's watching" picker) and passes a chosen id through when
// scheduling — creating/deleting profiles stays iptv-recorder's own job,
// reachable via the Recordings screen's "Open Recorder" link, the same
// "don't re-implement its admin surface here" stance used everywhere else.
export type Profile = {
  id: number;
  name: string;
  createdAt: string;
};

export type RecurrencePattern = {
  daysOfWeek: number;
  startMinuteOfDay: number;
  durationMinutes: number;
  endDate?: string;
  maxOccurrences?: number;
};

// Thrown instead of making a request when no recorder connection has been
// configured yet. Distinguishes "not configured" from an actual
// connectivity failure so callers can surface the right message — also
// doubles as the de facto "recording requires recorder mode" gate: local
// mode never has a recorder connection to configure in the first place.
export class RecorderNotConfiguredError extends Error {
  constructor() {
    super("no recorder connection configured (see PUT /config/recorder)");
    this.name = "RecorderNotConfiguredError";
  }
}

// Carries iptv-recorder's own HTTP status through so route handlers can
// preserve a meaningful reason (e.g. its 409 hard-rejects: disabled
// provider, storage exhaustion, concurrent-stream limit, same-channel
// conflict) instead of collapsing every failure to a generic 400.
export class RecorderApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "RecorderApiError";
  }
}

function requireConnection(): { baseUrl: string; apiKey: string } {
  const config = getRecorderConfig();
  if (!config.baseUrl || !config.apiKeyEncrypted) {
    throw new RecorderNotConfiguredError();
  }
  return { baseUrl: config.baseUrl, apiKey: decrypt(config.apiKeyEncrypted) };
}

async function rawRequest(baseUrl: string, apiKey: string, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${response.status}`;
    throw new RecorderApiError(response.status, message);
  }
  return body;
}

async function recorderRequest(path: string, init?: RequestInit): Promise<unknown> {
  const { baseUrl, apiKey } = requireConnection();
  return rawRequest(baseUrl, apiKey, path, init);
}

function withQuery(path: string, params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function listProviders(): Promise<RecorderProvider[]> {
  return (await recorderRequest("/providers")) as RecorderProvider[];
}

// Raw, unredacted credentials — iptv-recorder's own PLAN.md documents this
// as the one deliberate exception to "credentials redacted in every
// response", for exactly this kind of trusted sibling-service use. Never
// log or persist the result; use it for the immediate call and discard it.
export async function getProviderConnection(providerId: number): Promise<ProviderConnection> {
  return (await recorderRequest(`/providers/${providerId}/connection`)) as ProviderConnection;
}

// Validates a candidate baseUrl/apiKey pair against iptv-recorder before
// it's ever saved (PUT /config/recorder) — same "test before persisting"
// principle used throughout these services. GET /providers is the cheapest
// authenticated call available: a 2xx confirms both that baseUrl is
// reachable and that apiKey is accepted.
export async function testRecorderConnection(candidate: {
  baseUrl: string;
  apiKey: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await rawRequest(candidate.baseUrl, candidate.apiKey, "/providers");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function createOneOffRecording(input: { providerId: number; channelId: string; startTime: string; endTime: string; profileId?: number }): Promise<Recording> {
  return (await recorderRequest("/recordings", { method: "POST", body: JSON.stringify(input) })) as Recording;
}

export async function createRecurringRecording(input: { providerId: number; channelId: string; recurrence: RecurrencePattern; profileId?: number }): Promise<RecurringRule> {
  return (await recorderRequest("/recordings", { method: "POST", body: JSON.stringify(input) })) as RecurringRule;
}

export async function listProfiles(): Promise<Profile[]> {
  return (await recorderRequest("/profiles")) as Profile[];
}

export async function listRecordings(filter: RecordingsFilter = {}): Promise<Array<Recording | ProjectedOccurrence>> {
  return (await recorderRequest(withQuery("/recordings", filter))) as Array<Recording | ProjectedOccurrence>;
}

export async function getRecording(id: number): Promise<Recording> {
  return (await recorderRequest(`/recordings/${id}`)) as Recording;
}

export async function cancelRecording(id: number): Promise<void> {
  await recorderRequest(`/recordings/${id}`, { method: "DELETE" });
}

export async function listRecurringRules(filter: RecurringRulesFilter = {}): Promise<RecurringRule[]> {
  return (await recorderRequest(withQuery("/recordings/recurring", filter))) as RecurringRule[];
}

export async function cancelRecurringRule(ruleId: number): Promise<RecurringRuleCancelResult> {
  return (await recorderRequest(`/recordings/recurring/${ruleId}`, { method: "DELETE" })) as RecurringRuleCancelResult;
}

export async function skipOccurrence(ruleId: number, date: string): Promise<Recording | SkipException> {
  return (await recorderRequest(`/recordings/recurring/${ruleId}/skip`, { method: "POST", body: JSON.stringify({ date }) })) as Recording | SkipException;
}

// PLAN.md "Recorder page shortcut" — iptv-recorder's own GET /config/ui-url
// (env-backed, not a DB setting on its side) reports where its Settings UI
// is actually hosted. Used to power a plain "Open Recorder" link/button
// rather than this app ever re-implementing any of iptv-recorder's own
// admin surface (providers, storage/retention, clients, profiles) itself.
export async function getRecorderUiUrl(): Promise<{ url: string }> {
  return (await recorderRequest("/config/ui-url")) as { url: string };
}

// Not fetched here — the caller (routes/recordings.ts's POST /recordings/:id/stream)
// hands this straight to ffmpeg as its input URL + -headers, the same way a
// live channel or VOD title's own resolved streamUrl is handed to ffmpeg by
// ../liveChannels.ts/../vod.ts. ffmpeg/ffprobe fetch the bytes themselves;
// this app's own process never downloads or stores the recording.
export function getRecordingStreamSource(id: number): { url: string; headers: Record<string, string> } {
  const { baseUrl, apiKey } = requireConnection();
  return { url: `${baseUrl}/recordings/${id}/file`, headers: { Authorization: `Bearer ${apiKey}` } };
}
