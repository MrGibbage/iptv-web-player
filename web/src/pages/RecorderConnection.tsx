import { useEffect, useState, type FormEvent } from "react";
import { api, type RecorderConfig } from "../api";
import { QrScanner } from "./QrScanner";

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
  const [scanning, setScanning] = useState(false);

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

  // Shared by both the manual form and a successful QR scan — the scan
  // path can't just call setBaseUrl/setApiKey and then read the state back
  // synchronously (React state updates aren't applied until the next
  // render), so it passes the freshly-decoded values straight through
  // instead of relying on state that hasn't updated yet.
  async function submitConnection(url: string, key: string) {
    setError(undefined);
    setSaving(true);
    try {
      await api.put("/config/recorder", { baseUrl: url.trim(), apiKey: key.trim() });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    await submitConnection(baseUrl, apiKey);
  }

  // PLAN.md "QR pairing" — the scanned payload is a plain JSON string,
  // `{apiUrl, apiKey}` (iptv-recorder's own Clients.tsx, which generates
  // it, documents this exact shape). Auto-fills both fields (so what got
  // scanned is visible, not hidden) and auto-submits immediately — a scan
  // is already an unambiguous "connect using this," and submitConnection
  // still tests against iptv-recorder before saving anything, so a
  // garbled/wrong scan just surfaces as a normal form error, not a silent
  // bad state.
  function handleScan(text: string) {
    setScanning(false);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError("Scanned code isn't valid — expected an iptv-recorder client pairing code.");
      return;
    }
    const candidate = parsed as { apiUrl?: unknown; apiKey?: unknown };
    if (typeof candidate.apiUrl !== "string" || typeof candidate.apiKey !== "string") {
      setError("Scanned code is missing apiUrl/apiKey — expected an iptv-recorder client pairing code.");
      return;
    }
    setBaseUrl(candidate.apiUrl);
    setApiKey(candidate.apiKey);
    void submitConnection(candidate.apiUrl, candidate.apiKey);
  }

  if (config === "loading") {
    return <p>Loading…</p>;
  }

  if (!config.configured) {
    return (
      <section className="card">
        <h2>Connect to iptv-recorder</h2>
        <p>
          Paste the base URL and an API key issued via iptv-recorder's <code>POST /clients</code>, or scan the QR code shown when that client was created.
        </p>
        {scanning ? (
          <QrScanner onScan={handleScan} onCancel={() => setScanning(false)} />
        ) : (
          <p>
            <button type="button" onClick={() => setScanning(true)}>
              📷 Scan QR code
            </button>
          </p>
        )}
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
