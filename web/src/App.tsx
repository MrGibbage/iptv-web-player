import { useEffect, useRef, useState } from "react";
import { api, type Profile, type ProviderSourceConfig } from "./api";
import { ProviderSourceChoice } from "./pages/ProviderSourceChoice";
import { RecorderConnection } from "./pages/RecorderConnection";
import { LocalProviders } from "./pages/LocalProviders";
import { EpgGuide } from "./pages/EpgGuide";
import { VodBrowser } from "./pages/VodBrowser";
import { SeriesBrowser } from "./pages/SeriesBrowser";
import { Diagnostics } from "./pages/Diagnostics";
import { Recordings } from "./pages/Recordings";
import { getCurrentProfileId, getStartTab, setCurrentProfileId, setStartTab, type StartTab } from "./localSettings";
import { TAB_LABELS, TAB_ORDER, type Tab } from "./navConfig";

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
  // Plain state, not react-router-dom yet — worth switching to actual
  // routing if this grows further, same threshold iptv-scheduler crossed
  // before adopting it. Initial value is the user's persisted preference
  // (PLAN.md "Persisted UI settings") — harmless to default to a real tab
  // even before providers are configured, since `showChoice` below still
  // gates on that regardless of what `tab` happens to be.
  const [tab, setTab] = useState<Tab>(() => getStartTab());
  const [navOpen, setNavOpen] = useState(false);
  const [startTabPref, setStartTabPref] = useState<StartTab>(() => getStartTab());
  const [profiles, setProfiles] = useState<Profile[] | "loading" | "error">("loading");
  const [profileId, setProfileId] = useState<number | null>(() => getCurrentProfileId());
  const navRef = useRef<HTMLDivElement>(null);

  // PLAN.md "Profiles" — only meaningful in recorder mode (profiles are
  // iptv-recorder's own concept; there's no such thing in local mode).
  const recorderMode = config !== "loading" && config !== "error" && config.mode === "recorder";
  useEffect(() => {
    if (!recorderMode) return;
    api
      .get<Profile[]>("/profiles")
      .then(setProfiles)
      .catch(() => setProfiles("error"));
  }, [recorderMode]);

  function handleProfileChange(value: string) {
    const id = value === "" ? null : Number(value);
    setProfileId(id);
    setCurrentProfileId(id);
  }

  // Click-outside-to-close — standard expectation for a menu, especially on
  // a touchscreen where there's no "click elsewhere" affordance otherwise.
  useEffect(() => {
    if (!navOpen) return;
    function handlePointerDown(e: MouseEvent) {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setNavOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [navOpen]);

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

  function selectTab(t: Tab) {
    setTab(t);
    setNavOpen(false);
  }

  function handleStartTabChange(value: StartTab) {
    setStartTabPref(value);
    setStartTab(value);
  }

  const showChoice = config !== "loading" && config !== "error" && (config.mode === null || changingSource);
  const configured = config !== "loading" && config !== "error" && config.mode !== null;

  return (
    <main>
      {config === "loading" && <p>Loading…</p>}
      {config === "error" && <p className="error">Could not reach iptv-web-player's own API.</p>}
      {/* PLAN.md "Guide UI polish, round 3" — the Guide screen renders its own
          copy of this same nav (folded into a single hamburger next to its
          preview dock, no separate row above it), so this one is hidden
          there to avoid two stacked hamburgers. Every other screen still
          gets this one, unchanged. */}
      {configured && !showChoice && tab !== "guide" && (
        <nav className="nav" ref={navRef}>
          <button type="button" className="hamburger-trigger" aria-label="Menu" onClick={() => setNavOpen((v) => !v)}>
            ☰
          </button>
          <span className="nav-current-tab">{TAB_LABELS[tab]}</span>
          {navOpen && (
            <div className="hamburger-panel">
              {TAB_ORDER.map((t) => (
                <button key={t} type="button" className={tab === t ? "active" : ""} onClick={() => selectTab(t)}>
                  {TAB_LABELS[t]}
                </button>
              ))}
              <div className="hamburger-divider" />
              <label className="hamburger-pref">
                Start screen
                <select value={startTabPref} onChange={(e) => handleStartTabChange(e.target.value as StartTab)}>
                  {TAB_ORDER.filter((t): t is StartTab => t === "guide" || t === "vod" || t === "series" || t === "recordings").map((t) => (
                    <option key={t} value={t}>
                      {TAB_LABELS[t]}
                    </option>
                  ))}
                </select>
              </label>
              {recorderMode && (
                <label className="hamburger-pref">
                  Who's watching
                  <select value={profileId ?? ""} onChange={(e) => handleProfileChange(e.target.value)} disabled={profiles === "loading" || profiles === "error"}>
                    <option value="">No profile selected</option>
                    {profiles !== "loading" &&
                      profiles !== "error" &&
                      profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </div>
          )}
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
          <EpgGuide tab={tab} onSelectTab={selectTab} startTabPref={startTabPref} onStartTabChange={handleStartTabChange} />
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
