import { useEffect, useState } from "react";
import { api, type ProviderSourceConfig } from "./api";
import { ProviderSourceChoice } from "./pages/ProviderSourceChoice";
import { RecorderConnection } from "./pages/RecorderConnection";
import { LocalProviders } from "./pages/LocalProviders";
import { LiveChannels } from "./pages/LiveChannels";
import { EpgGuide } from "./pages/EpgGuide";
import { VodBrowser } from "./pages/VodBrowser";

type LoadState = ProviderSourceConfig | "loading" | "error";
type Tab = "providers" | "live" | "guide" | "vod";

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
  // Plain state, not react-router-dom yet — only two real areas exist so
  // far (provider management, Live TV browsing). Worth switching to actual
  // routing once there are enough pages to justify it (Guide/VOD/Series),
  // same threshold iptv-scheduler crossed before adopting it.
  const [tab, setTab] = useState<Tab>("providers");

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
  const configured = config !== "loading" && config !== "error" && config.mode !== null;

  return (
    <main>
      <h1>iptv-web-player</h1>
      {config === "loading" && <p>Loading…</p>}
      {config === "error" && <p className="error">Could not reach iptv-web-player's own API.</p>}
      {configured && !showChoice && (
        <nav className="nav">
          <button type="button" className={tab === "providers" ? "active" : ""} onClick={() => setTab("providers")}>
            Providers
          </button>
          <button type="button" className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}>
            Live TV
          </button>
          <button type="button" className={tab === "guide" ? "active" : ""} onClick={() => setTab("guide")}>
            Guide
          </button>
          <button type="button" className={tab === "vod" ? "active" : ""} onClick={() => setTab("vod")}>
            Movies
          </button>
        </nav>
      )}
      {showChoice && <ProviderSourceChoice onChosen={handleChosen} />}
      {!showChoice && config !== "loading" && config !== "error" && config.mode === "recorder" && tab === "providers" && (
        <RecorderConnection onChangeSource={() => setChangingSource(true)} />
      )}
      {!showChoice && config !== "loading" && config !== "error" && config.mode === "local" && tab === "providers" && (
        <LocalProviders onChangeSource={() => setChangingSource(true)} />
      )}
      {!showChoice && configured && tab === "live" && <LiveChannels />}
      {!showChoice && configured && tab === "guide" && (
        <div className="guide-container">
          <EpgGuide />
        </div>
      )}
      {!showChoice && configured && tab === "vod" && <VodBrowser />}
    </main>
  );
}

export default App;
