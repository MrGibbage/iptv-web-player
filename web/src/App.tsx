import { useEffect, useState } from "react";
import { api, type ProviderSourceConfig } from "./api";
import { ProviderSourceChoice } from "./pages/ProviderSourceChoice";
import { RecorderConnection } from "./pages/RecorderConnection";
import { LocalProviders } from "./pages/LocalProviders";
import { EpgGuide } from "./pages/EpgGuide";
import { VodBrowser } from "./pages/VodBrowser";
import { SeriesBrowser } from "./pages/SeriesBrowser";
import { Diagnostics } from "./pages/Diagnostics";
import { Recordings } from "./pages/Recordings";

type LoadState = ProviderSourceConfig | "loading" | "error";
type Tab = "providers" | "guide" | "vod" | "series" | "recordings" | "diagnostics";

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
  // Plain state, not react-router-dom yet — worth switching to actual
  // routing if this grows further, same threshold iptv-scheduler crossed
  // before adopting it.
  const [tab, setTab] = useState<Tab>("providers");
  // Lifted up from EpgGuide.tsx so its "Updated Xh ago · N channels ·
  // N programs" status can render in this nav row instead of costing the
  // Guide screen a whole extra toolbar row of its own (PLAN.md "Guide UI
  // polish") — matters most on a landscape tablet, where vertical space is
  // the scarce resource.
  const [guideStatusText, setGuideStatusText] = useState("");
  const [guideStatusError, setGuideStatusError] = useState(false);

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

  function handleGuideStatusText(text: string, isError: boolean) {
    setGuideStatusText(text);
    setGuideStatusError(isError);
  }

  const showChoice = config !== "loading" && config !== "error" && (config.mode === null || changingSource);
  const configured = config !== "loading" && config !== "error" && config.mode !== null;

  return (
    <main>
      {config === "loading" && <p>Loading…</p>}
      {config === "error" && <p className="error">Could not reach iptv-web-player's own API.</p>}
      {configured && !showChoice && (
        <nav className="nav">
          <button type="button" className={tab === "providers" ? "active" : ""} onClick={() => setTab("providers")}>
            Providers
          </button>
          <button type="button" className={tab === "guide" ? "active" : ""} onClick={() => setTab("guide")}>
            Live TV / Guide
          </button>
          <button type="button" className={tab === "vod" ? "active" : ""} onClick={() => setTab("vod")}>
            Movies
          </button>
          <button type="button" className={tab === "series" ? "active" : ""} onClick={() => setTab("series")}>
            TV Shows
          </button>
          <button type="button" className={tab === "recordings" ? "active" : ""} onClick={() => setTab("recordings")}>
            Recordings
          </button>
          <button type="button" className={tab === "diagnostics" ? "active" : ""} onClick={() => setTab("diagnostics")}>
            Diagnostics
          </button>
          {tab === "guide" && guideStatusText && <span className={`nav-status${guideStatusError ? " nav-status-error" : ""}`}>{guideStatusText}</span>}
        </nav>
      )}
      {showChoice && <ProviderSourceChoice onChosen={handleChosen} />}
      {!showChoice && config !== "loading" && config !== "error" && config.mode === "recorder" && tab === "providers" && (
        <RecorderConnection onChangeSource={() => setChangingSource(true)} />
      )}
      {!showChoice && config !== "loading" && config !== "error" && config.mode === "local" && tab === "providers" && (
        <LocalProviders onChangeSource={() => setChangingSource(true)} />
      )}
      {!showChoice && configured && tab === "guide" && (
        <div className="guide-container">
          <EpgGuide onStatusTextChange={handleGuideStatusText} />
        </div>
      )}
      {!showChoice && configured && tab === "vod" && <VodBrowser />}
      {!showChoice && configured && tab === "series" && <SeriesBrowser />}
      {!showChoice && configured && tab === "recordings" && <Recordings />}
      {!showChoice && configured && tab === "diagnostics" && <Diagnostics />}
    </main>
  );
}

export default App;
