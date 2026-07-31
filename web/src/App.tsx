import { useEffect, useState } from "react";
import { api, type ProviderSourceConfig } from "./api";
import { ProviderSourceChoice } from "./pages/ProviderSourceChoice";
import { RecorderConnection } from "./pages/RecorderConnection";
import { LocalProviders } from "./pages/LocalProviders";

type LoadState = ProviderSourceConfig | "loading" | "error";

// PLAN.md "Credentials Model" — provider-source mode is the one global
// blocking state everything else sits behind, the same way iptv-scheduler
// gates everything behind a working recorder connection. Nothing else is
// built yet, so this is the whole app for now.
function App() {
  const [config, setConfig] = useState<LoadState>("loading");
  // Decoupled from `config`: "change source" shows the choice screen again
  // without touching the persisted mode until the user actually picks one —
  // there's no "unset" server state to bounce through in between.
  const [changingSource, setChangingSource] = useState(false);

  function refresh() {
    setConfig("loading");
    api
      .get<ProviderSourceConfig>("/config/provider-source")
      .then(setConfig)
      .catch(() => setConfig("error"));
  }

  useEffect(refresh, []);

  function handleChosen() {
    setChangingSource(false);
    refresh();
  }

  const showChoice = config !== "loading" && config !== "error" && (config.mode === null || changingSource);

  return (
    <main>
      <h1>iptv-web-player</h1>
      {config === "loading" && <p>Loading…</p>}
      {config === "error" && <p className="error">Could not reach iptv-web-player's own API.</p>}
      {showChoice && <ProviderSourceChoice onChosen={handleChosen} />}
      {!showChoice && config !== "loading" && config !== "error" && config.mode === "recorder" && (
        <RecorderConnection onChangeSource={() => setChangingSource(true)} />
      )}
      {!showChoice && config !== "loading" && config !== "error" && config.mode === "local" && (
        <LocalProviders onChangeSource={() => setChangingSource(true)} />
      )}
    </main>
  );
}

export default App;
