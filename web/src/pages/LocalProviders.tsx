import { useEffect, useState, type FormEvent } from "react";
import { api, type AuthCheckResult, type Provider, type ProviderType } from "../api";

type Props = {
  onChangeSource: () => void;
};

const emptyForm = {
  name: "",
  type: "xtream" as ProviderType,
  baseUrl: "",
  username: "",
  password: "",
  playlistUrl: "",
  epgUrl: "",
};

// PLAN.md "Credentials Model" — active only when provider-source mode is
// 'local'. Mirrors iptv-recorder's own provider management: add/test/list/
// delete, credentials never round-tripped back from the API once saved.
export function LocalProviders({ onChangeSource }: Props) {
  const [providers, setProviders] = useState<Provider[] | "loading">("loading");
  const [form, setForm] = useState(emptyForm);
  const [testResult, setTestResult] = useState<AuthCheckResult>();
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  function refresh() {
    setProviders("loading");
    api
      .get<Provider[]>("/providers")
      .then(setProviders)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(refresh, []);

  function buildPayload() {
    return form.type === "xtream"
      ? { name: form.name, type: "xtream" as const, baseUrl: form.baseUrl, username: form.username, password: form.password }
      : { name: form.name, type: "m3u" as const, playlistUrl: form.playlistUrl, epgUrl: form.epgUrl || undefined };
  }

  async function handleTest() {
    setError(undefined);
    setTestResult(undefined);
    setTesting(true);
    try {
      const payload = buildPayload();
      const { name: _name, ...credentials } = payload;
      setTestResult(await api.post<AuthCheckResult>("/providers/test", credentials));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setSaving(true);
    try {
      await api.post("/providers", buildPayload());
      setForm(emptyForm);
      setTestResult(undefined);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    try {
      await api.delete(`/providers/${id}`);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const canTest = form.type === "xtream" ? Boolean(form.baseUrl && form.username && form.password) : Boolean(form.playlistUrl);

  return (
    <section className="page">
      <div className="page-header">
        <h2>Providers</h2>
        <button type="button" className="button-link" onClick={onChangeSource}>
          Change source
        </button>
      </div>

      {providers === "loading" ? (
        <p>Loading…</p>
      ) : providers.length === 0 ? (
        <p className="muted">No providers yet — add one below.</p>
      ) : (
        <ul>
          {providers.map((p) => (
            <li key={p.id}>
              {p.name} — {p.type}
              {p.baseUrl ? ` (${p.baseUrl})` : ""}
              {!p.enabled && " (disabled)"}{" "}
              <button type="button" className="button-danger" onClick={() => handleDelete(p.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="card">
        <h2>Add a provider</h2>
        <form onSubmit={handleSubmit} className="form">
          <label>
            Name
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </label>
          <label>
            Type
            <select
              value={form.type}
              onChange={(e) => {
                setForm({ ...form, type: e.target.value as ProviderType });
                setTestResult(undefined);
              }}
            >
              <option value="xtream">Xtream Codes</option>
              <option value="m3u">M3U playlist</option>
            </select>
          </label>

          {form.type === "xtream" ? (
            <>
              <label>
                Server URL
                <input type="text" placeholder="http://provider.example.com:8080" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
              </label>
              <label>
                Username
                <input type="text" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
              </label>
              <label>
                Password
                <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </label>
            </>
          ) : (
            <>
              <label>
                Playlist URL
                <input type="text" placeholder="http://provider.example.com/playlist.m3u" value={form.playlistUrl} onChange={(e) => setForm({ ...form, playlistUrl: e.target.value })} />
              </label>
              <label>
                XMLTV EPG URL (optional)
                <input type="text" value={form.epgUrl} onChange={(e) => setForm({ ...form, epgUrl: e.target.value })} />
              </label>
            </>
          )}

          <div className="row-actions">
            <button type="button" disabled={!canTest || testing} onClick={handleTest}>
              {testing ? "Testing…" : "Test connection"}
            </button>
            <button type="submit" disabled={saving || !form.name || !canTest}>
              {saving ? "Saving…" : "Add provider"}
            </button>
          </div>
        </form>
        {testResult && (
          <p className={testResult.ok ? "muted" : "error"}>{testResult.ok ? "Connection succeeded." : `Connection failed: ${testResult.error}`}</p>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </section>
  );
}
