import { useEffect, useState, type FormEvent } from "react";
import { api, type RecorderConfig } from "../api";

type RecorderProvider = { id: number; name: string; type: "xtream" | "m3u"; baseUrl: string | null; enabled: boolean };

type Props = {
  onChangeSource: () => void;
};

// PLAN.md "Credentials Model" — active only when provider-source mode is
// 'recorder'. Mirrors iptv-scheduler's own RecorderSettings.tsx: PUT
// validates against iptv-recorder before saving, so a typo or a revoked key
// surfaces immediately as a form error instead of failing silently later.
export function RecorderConnection({ onChangeSource }: Props) {
  const [config, setConfig] = useState<RecorderConfig | "loading">("loading");
  const [providers, setProviders] = useState<RecorderProvider[]>([]);
  const [providersError, setProvidersError] = useState<string>();
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  function refresh() {
    setConfig("loading");
    api
      .get<RecorderConfig>("/config/recorder")
      .then(setConfig)
      .catch(() => setConfig({ baseUrl: null, configured: false, updatedAt: new Date().toISOString() }));
  }

  useEffect(refresh, []);

  useEffect(() => {
    if (config !== "loading" && config.configured) {
      api
        .get<RecorderProvider[]>("/config/recorder/providers")
        .then(setProviders)
        .catch((err) => setProvidersError(err instanceof Error ? err.message : String(err)));
    }
  }, [config]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setSaving(true);
    try {
      await api.put("/config/recorder", { baseUrl: baseUrl.trim(), apiKey: apiKey.trim() });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (config === "loading") {
    return <p>Loading…</p>;
  }

  if (!config.configured) {
    return (
      <section className="card">
        <h2>Connect to iptv-recorder</h2>
        <p>
          Paste the base URL and an API key issued via iptv-recorder's <code>POST /clients</code>.
        </p>
        <form onSubmit={handleSubmit} className="form">
          <label>
            Recorder base URL
            <input type="text" placeholder="http://localhost:3000" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} autoFocus />
          </label>
          <label>
            API key
            <input type="password" placeholder="API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </label>
          <button type="submit" disabled={saving || baseUrl.trim().length === 0 || apiKey.trim().length === 0}>
            {saving ? "Connecting…" : "Connect"}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
        <p>
          <button type="button" className="button-link" onClick={onChangeSource}>
            Use my own provider details instead
          </button>
        </p>
      </section>
    );
  }

  return (
    <section className="card" style={{ maxWidth: 640 }}>
      <div className="page-header">
        <h2>iptv-recorder providers</h2>
        <button type="button" className="button-link" onClick={onChangeSource}>
          Change source
        </button>
      </div>
      <p className="muted">Connected to {config.baseUrl}</p>
      {providersError && <p className="error">{providersError}</p>}
      {providers.length === 0 && !providersError ? (
        <p className="muted">No providers configured on iptv-recorder yet — add one there first.</p>
      ) : (
        <ul>
          {providers.map((p) => (
            <li key={p.id}>
              {p.name} — {p.type}
              {!p.enabled && " (disabled)"}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
