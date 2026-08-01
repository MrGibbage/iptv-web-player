import { useState } from "react";
import { api, ApiError } from "../api";
import { getCurrentProfileId } from "../localSettings";
import "./record.css";

type Props = {
  providerId: number;
  channelId: string;
  channelName: string;
  initialStart: Date;
  initialEnd: Date;
  onClose: () => void;
  onScheduled: () => void;
};

// Ported from Laomedeia (src/components/RecordDialog.tsx) — same one-off vs.
// recurring toggle, same day-of-week bitmask picker. Talks to this app's own
// proxy routes (server/src/routes/recordings.ts) instead of Electron IPC to
// iptv-recorder directly; otherwise the same shape (recurrence.startMinuteOfDay
// is UTC, enforced server-side by iptv-recorder itself — labelled explicitly
// here for the same reason Lao's RecordingsBrowser does).
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function toLocalDatetimeInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dayBit(date: Date): number {
  // JS Date.getDay(): 0=Sunday..6=Saturday. Recorder bitmask: bit 0=Monday..bit 6=Sunday.
  return (date.getDay() + 6) % 7;
}

export function RecordDialog({ providerId, channelId, channelName, initialStart, initialEnd, onClose, onScheduled }: Props) {
  const [mode, setMode] = useState<"one-off" | "recurring">("one-off");
  const [startInput, setStartInput] = useState(() => toLocalDatetimeInput(initialStart));
  const [endInput, setEndInput] = useState(() => toLocalDatetimeInput(initialEnd));
  const [days, setDays] = useState<Set<number>>(() => new Set([dayBit(initialStart)]));
  const [startTimeInput, setStartTimeInput] = useState(() => {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(initialStart.getHours())}:${pad(initialStart.getMinutes())}`;
  });
  const [durationMinutes, setDurationMinutes] = useState(() => Math.max(1, Math.round((initialEnd.getTime() - initialStart.getTime()) / 60_000)));
  const [endDateInput, setEndDateInput] = useState("");
  const [maxOccurrencesInput, setMaxOccurrencesInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);

  const toggleDay = (bit: number) => {
    const next = new Set(days);
    if (next.has(bit)) next.delete(bit);
    else next.add(bit);
    setDays(next);
  };

  const daysMask = () => Array.from(days).reduce((mask, bit) => mask | (1 << bit), 0);

  async function handleSubmit() {
    setSubmitting(true);
    setMessage(null);
    try {
      if (mode === "one-off") {
        const start = new Date(startInput);
        const end = new Date(endInput);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
          setMessage({ text: "End time must be after start time.", isError: true });
          return;
        }
        await api.post("/recordings", { providerId, channelId, startTime: start.toISOString(), endTime: end.toISOString(), profileId: getCurrentProfileId() ?? undefined });
        setMessage({ text: "Recording scheduled.", isError: false });
      } else {
        const mask = daysMask();
        if (mask === 0) {
          setMessage({ text: "Pick at least one day.", isError: true });
          return;
        }
        const [h, m] = startTimeInput.split(":").map(Number);
        if (Number.isNaN(h) || Number.isNaN(m)) {
          setMessage({ text: "Enter a valid start time.", isError: true });
          return;
        }
        const maxOccurrences = maxOccurrencesInput ? Number(maxOccurrencesInput) : undefined;
        await api.post("/recordings", {
          providerId,
          channelId,
          recurrence: {
            daysOfWeek: mask,
            startMinuteOfDay: h * 60 + m,
            durationMinutes,
            endDate: endDateInput ? new Date(endDateInput).toISOString() : undefined,
            maxOccurrences,
          },
          profileId: getCurrentProfileId() ?? undefined,
        });
        setMessage({ text: "Recurring recording scheduled.", isError: false });
      }
      onScheduled();
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err), isError: true });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="record-dialog-backdrop" onClick={onClose}>
      <div className="record-dialog-card" onClick={(e) => e.stopPropagation()}>
        <div className="page-header">
          <h2>Record — {channelName}</h2>
          <button type="button" className="button-link" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="vod-scope-toggle" style={{ marginBottom: 14 }}>
          <button type="button" className={`vod-scope-btn${mode === "one-off" ? " active" : ""}`} onClick={() => setMode("one-off")}>
            One-off
          </button>
          <button type="button" className={`vod-scope-btn${mode === "recurring" ? " active" : ""}`} onClick={() => setMode("recurring")}>
            Recurring
          </button>
        </div>

        {mode === "one-off" ? (
          <div className="form">
            <label>
              Start
              <input type="datetime-local" value={startInput} onChange={(e) => setStartInput(e.target.value)} />
            </label>
            <label>
              End
              <input type="datetime-local" value={endInput} onChange={(e) => setEndInput(e.target.value)} />
            </label>
          </div>
        ) : (
          <div className="form">
            <label>
              Days
              <div className="vod-scope-toggle record-dialog-days">
                {DAY_LABELS.map((label, bit) => (
                  <button key={label} type="button" className={`vod-scope-btn${days.has(bit) ? " active" : ""}`} onClick={() => toggleDay(bit)}>
                    {label}
                  </button>
                ))}
              </div>
            </label>
            <label>
              Start time (UTC)
              <input type="time" value={startTimeInput} onChange={(e) => setStartTimeInput(e.target.value)} />
            </label>
            <label>
              Duration (minutes)
              <input type="number" min={1} value={durationMinutes} onChange={(e) => setDurationMinutes(Math.max(1, Number(e.target.value) || 1))} />
            </label>
            <label>
              End date (optional)
              <input type="date" value={endDateInput} onChange={(e) => setEndDateInput(e.target.value)} />
            </label>
            <label>
              Max occurrences (optional)
              <input type="number" min={1} value={maxOccurrencesInput} onChange={(e) => setMaxOccurrencesInput(e.target.value)} />
            </label>
          </div>
        )}

        <div className="row-actions" style={{ marginTop: 16 }}>
          <button type="button" onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Scheduling…" : "Schedule Recording"}
          </button>
        </div>

        {message && <p className={message.isError ? "error" : "muted"}>{message.text}</p>}
      </div>
    </div>
  );
}
