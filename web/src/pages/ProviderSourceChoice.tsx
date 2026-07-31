import { useState } from "react";
import { api } from "../api";

type Props = {
  onChosen: (mode: "recorder" | "local") => void;
};

// PLAN.md "Credentials Model" — the "ask first" setup screen. Every other
// feature (EPG, live/VOD/series browsing, playback) sits behind this
// choice being made, the same way iptv-scheduler gates everything behind a
// working recorder connection.
export function ProviderSourceChoice({ onChosen }: Props) {
  const [saving, setSaving] = useState<"recorder" | "local" | null>(null);
  const [error, setError] = useState<string>();

  async function choose(mode: "recorder" | "local") {
    setError(undefined);
    setSaving(mode);
    try {
      await api.put("/config/provider-source", { mode });
      onChosen(mode);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="card" style={{ maxWidth: 640 }}>
      <h2>Where do your provider credentials live?</h2>
      <p>
        This app needs an Xtream or M3U provider account to show Live TV, EPG, Movies, and Series. If you already
        have <code>iptv-recorder</code> configured with the account you want to watch, use that instead of entering
        it again — otherwise, enter your provider details directly here.
      </p>
      <div className="form">
        <button type="button" disabled={saving !== null} onClick={() => choose("recorder")}>
          {saving === "recorder" ? "Saving…" : "Use iptv-recorder's credentials"}
        </button>
        <button type="button" disabled={saving !== null} onClick={() => choose("local")}>
          {saving === "local" ? "Saving…" : "Enter my own provider details"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
