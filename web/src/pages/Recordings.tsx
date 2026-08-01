import { useEffect, useMemo, useState } from "react";
import { api, isProjectedOccurrence, type EffectiveProvider, type LiveChannel, type ProjectedOccurrence, type ProviderSourceConfig, type Recording, type RecurringRule } from "../api";
import { Player } from "./Player";
import "./record.css";

// Ported from Laomedeia (src/components/RecordingsBrowser.tsx) — same
// Recording Now / Scheduled / Recurring Rules / Completed / Failed
// sections, same actions per section. Talks to this app's own recorder-proxy
// routes (server/src/routes/recordings.ts) instead of Electron IPC.
//
// Only meaningful in recorder mode (PLAN.md "Recording support") — recording
// is entirely iptv-recorder's job, there's no local equivalent. Fetches
// /config/provider-source itself (same "acceptable duplication for now"
// pattern every other page here uses, see EpgGuide.tsx) rather than lifting
// mode into shared app state.
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtDaysOfWeek(mask: number): string {
  if (mask === 127) return "Every day";
  const days = DAY_LABELS.filter((_, i) => (mask & (1 << i)) !== 0);
  return days.length > 0 ? days.join(", ") : "No days set";
}

// startMinuteOfDay is always UTC (enforced server-side by iptv-recorder) —
// labelled explicitly rather than implying it's the viewer's local time.
function fmtMinuteOfDay(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

export function Recordings() {
  const [config, setConfig] = useState<ProviderSourceConfig | "loading" | "error">("loading");
  const [providers, setProviders] = useState<EffectiveProvider[]>([]);
  const [providerId, setProviderId] = useState<number | null>(null);
  const [channels, setChannels] = useState<LiveChannel[]>([]);
  const [recordings, setRecordings] = useState<Array<Recording | ProjectedOccurrence>>([]);
  const [rules, setRules] = useState<RecurringRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [actionMessage, setActionMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [playing, setPlaying] = useState<Recording | null>(null);

  useEffect(() => {
    api
      .get<ProviderSourceConfig>("/config/provider-source")
      .then(setConfig)
      .catch(() => setConfig("error"));
  }, []);

  useEffect(() => {
    if (config === "loading" || config === "error" || config.mode !== "recorder") return;
    api
      .get<EffectiveProvider[]>("/effective-providers")
      .then((list) => {
        setProviders(list);
        if (list.length > 0) setProviderId(list[0].id);
      })
      .catch(() => {});
  }, [config]);

  useEffect(() => {
    if (providerId === null) return;
    api
      .get<LiveChannel[]>(`/providers/${providerId}/live/channels`)
      .then(setChannels)
      .catch(() => setChannels([]));
  }, [providerId]);

  useEffect(() => {
    if (providerId === null) return;
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    Promise.all([
      api.get<Array<Recording | ProjectedOccurrence>>(`/recordings?providerId=${providerId}&includeProjected=true`),
      api.get<RecurringRule[]>(`/recordings/recurring?providerId=${providerId}&cancelled=false`),
    ])
      .then(([rec, rul]) => {
        if (cancelled) return;
        setRecordings(rec);
        setRules(rul);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [providerId, refreshTick]);

  const refresh = () => setRefreshTick((n) => n + 1);

  const channelLabel = useMemo(() => {
    const map = new Map(channels.map((c) => [c.channelId, c.name]));
    return (channelId: string) => map.get(channelId) ?? `Channel ${channelId}`;
  }, [channels]);

  const recordingNow = recordings.filter((r): r is Recording => !isProjectedOccurrence(r) && r.status === "recording");
  const scheduled = recordings.filter((r) => r.status === "scheduled").sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  const completed = recordings
    .filter((r): r is Recording => !isProjectedOccurrence(r) && r.status === "completed")
    .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  const failed = recordings.filter((r): r is Recording => !isProjectedOccurrence(r) && r.status === "failed");

  async function runAction(label: string, action: () => Promise<unknown>) {
    setActionMessage(null);
    try {
      await action();
      setActionMessage({ text: `${label} succeeded.`, isError: false });
      refresh();
    } catch (err) {
      setActionMessage({ text: err instanceof Error ? err.message : String(err), isError: true });
    }
  }

  const cancelOne = (id: number) => runAction("Cancel", () => api.delete(`/recordings/${id}`));
  const deleteOne = (id: number) => runAction("Delete", () => api.delete(`/recordings/${id}`));
  const cancelSeries = (ruleId: number) => runAction("Cancel series", () => api.delete(`/recordings/recurring/${ruleId}`));
  const skipOne = (ruleId: number, startTime: string) => runAction("Skip", () => api.post(`/recordings/recurring/${ruleId}/skip`, { date: dateOnly(startTime) }));

  if (config === "loading") return <p>Loading…</p>;
  if (config === "error") return <p className="error">Could not load configuration.</p>;
  if (config.mode !== "recorder") {
    return (
      <section className="page">
        <h2>Recordings</h2>
        <p className="muted">Recording is provided by iptv-recorder, and this app has no recording capability of its own — switch to recorder mode (Providers tab) to schedule and manage DVR recordings.</p>
      </section>
    );
  }

  return (
    <section className="page">
      <div className="page-header">
        <h2>Recordings</h2>
        <div className="row-actions">
          {providers.length > 1 && (
            <select value={providerId ?? ""} onChange={(e) => setProviderId(Number(e.target.value))}>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <button type="button" onClick={refresh} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {actionMessage && <p className={actionMessage.isError ? "error" : "muted"}>{actionMessage.text}</p>}
      {error && <p className="error">Failed to load recordings: {error}</p>}

      {recordingNow.length > 0 && (
        <>
          <h3>Recording Now</h3>
          {recordingNow.map((row) => (
            <div key={row.id} className="row-actions" style={{ justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <span>
                <strong>{channelLabel(row.channelId)}</strong> — {fmtDateTime(row.startTime)} – {fmtDateTime(row.endTime)}
              </span>
              <button type="button" onClick={() => cancelOne(row.id)}>
                Stop
              </button>
            </div>
          ))}
        </>
      )}

      <h3>Scheduled</h3>
      {scheduled.length === 0 ? (
        <p className="muted">Nothing scheduled.</p>
      ) : (
        scheduled.map((row) => {
          const projected = isProjectedOccurrence(row);
          return (
            <div
              key={projected ? `${row.recurringRuleId}:${row.startTime}` : `rec:${row.id}`}
              className="row-actions"
              style={{ justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}
            >
              <span>
                <strong>{channelLabel(row.channelId)}</strong> — {fmtDateTime(row.startTime)} – {fmtDateTime(row.endTime)}
                {row.recurringRuleId != null && <span className="muted"> · recurring</span>}
                {projected && <span className="muted"> · upcoming</span>}
              </span>
              {projected ? (
                <button type="button" onClick={() => skipOne(row.recurringRuleId, row.startTime)}>
                  Skip
                </button>
              ) : (
                <button type="button" onClick={() => cancelOne(row.id)}>
                  Cancel
                </button>
              )}
            </div>
          );
        })
      )}

      {rules.length > 0 && (
        <>
          <h3>Recurring Rules</h3>
          {rules.map((rule) => (
            <div key={rule.id} className="row-actions" style={{ justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <span>
                <strong>{channelLabel(rule.channelId)}</strong> — {fmtDaysOfWeek(rule.daysOfWeek)} at {fmtMinuteOfDay(rule.startMinuteOfDay)} UTC for {rule.durationMinutes} min
                {rule.maxOccurrences != null ? ` · up to ${rule.maxOccurrences} occurrences` : ""}
                {rule.endDate ? ` · until ${new Date(rule.endDate).toLocaleDateString()}` : ""}
              </span>
              <button type="button" onClick={() => cancelSeries(rule.id)}>
                Cancel Series
              </button>
            </div>
          ))}
        </>
      )}

      <h3>Completed</h3>
      {completed.length === 0 ? (
        <p className="muted">No completed recordings yet.</p>
      ) : (
        completed.map((row) => (
          <div key={row.id} className="row-actions" style={{ justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
            <span>
              <strong>{channelLabel(row.channelId)}</strong> — {fmtDateTime(row.startTime)} – {fmtDateTime(row.endTime)}
            </span>
            <div className="row-actions">
              <button type="button" onClick={() => setPlaying(row)}>
                ▶ Play
              </button>
              <button type="button" className="button-danger" onClick={() => deleteOne(row.id)}>
                Delete
              </button>
            </div>
          </div>
        ))
      )}

      {failed.length > 0 && (
        <>
          <h3>Failed</h3>
          {failed.map((row) => (
            <div key={row.id} className="row-actions" style={{ justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <span>
                <strong>{channelLabel(row.channelId)}</strong> — {fmtDateTime(row.startTime)} – {fmtDateTime(row.endTime)}
                {row.failureReason && <span className="error"> · {row.failureReason}</span>}
              </span>
              <button type="button" className="button-danger" onClick={() => deleteOne(row.id)}>
                Delete
              </button>
            </div>
          ))}
        </>
      )}

      {playing && (
        <Player providerId={playing.providerId} kind="recording" mediaId={String(playing.id)} channelName={channelLabel(playing.channelId)} onClose={() => setPlaying(null)} />
      )}
    </section>
  );
}
