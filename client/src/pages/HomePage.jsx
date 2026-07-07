import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Download, Music, Search, RefreshCw, ArrowRight, Loader } from "lucide-react";

const normalizeApiBase = (rawUrl) => {
  const value = (rawUrl || "").trim();
  if (!value) return "http://localhost:5000";
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withProtocol.replace(/\/+$/, "");
};

const MODES = { MEDIA: "media", MUSIC: "music" };
const API = normalizeApiBase(import.meta.env.VITE_API_URL);
const CLIENT_ID_STORAGE_KEY = "downvid_client_id";

const platformConfig = [
  { key: "youtube", label: "YouTube", keyword: "download YouTube videos", pattern: /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i },
  { key: "tiktok", label: "TikTok", keyword: "download TikTok videos", pattern: /^(https?:\/\/)?(www\.)?(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)\//i },
  { key: "instagram", label: "Instagram", keyword: "download Instagram videos", pattern: /^(https?:\/\/)?(www\.)?instagram\.com\//i },
  { key: "facebook", label: "Facebook", keyword: "download Facebook videos", pattern: /^(https?:\/\/)?(www\.)?(facebook\.com|fb\.watch)\//i },
  { key: "pinterest", label: "Pinterest", keyword: "download Pinterest videos", pattern: /^(https?:\/\/)?(www\.)?(pinterest\.[a-z.]{2,}|pin\.it)\//i },
  { key: "x", label: "X / Twitter", keyword: "download X videos", pattern: /^(https?:\/\/)?(www\.)?(x\.com|twitter\.com)\//i },
  { key: "reddit", label: "Reddit", keyword: "download Reddit videos", pattern: /^(https?:\/\/)?(www\.)?reddit\.com\//i },
];

const getClientId = () => {
  const existing = window.localStorage.getItem(CLIENT_ID_STORAGE_KEY);
  if (existing) return existing;
  const generated = window.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, generated);
  return generated;
};

const parseErrorMessage = async (response) => {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = await response.json();
    return data?.error || "Server error";
  }
  return (await response.text()) || "Server error";
};

export default function HomePage({ platformKey = "", forceMode = "" }) {
  const navigate = useNavigate();
  const activePlatform = platformConfig.find((item) => item.key === platformKey) || null;
  const [mode, setMode] = useState(forceMode === MODES.MUSIC ? MODES.MUSIC : MODES.MEDIA);
  const [url, setUrl] = useState("");
  const [musicQuery, setMusicQuery] = useState("");
  const [musicSessionId, setMusicSessionId] = useState("");
  const [musicSuggestions, setMusicSuggestions] = useState([]);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searchingMusic, setSearchingMusic] = useState(false);
  const [lastMusicAttempt, setLastMusicAttempt] = useState("");
  const [clientId] = useState(() => getClientId());
  const musicSearchInFlightRef = useRef(false);

  useEffect(() => {
    setMode(forceMode === MODES.MUSIC ? MODES.MUSIC : MODES.MEDIA);
  }, [forceMode]);

  useEffect(() => {
    setStatus("");
    if (mode === MODES.MEDIA) {
      setSearchingMusic(false);
      setMusicSuggestions([]);
      setMusicSessionId("");
    }
  }, [mode]);

  useEffect(() => {
    const pageTitle = activePlatform
      ? `Free ${activePlatform.label} Video Downloader | Fast ${activePlatform.label} Download Tool`
      : "Free Video Downloader & Music Downloader | YouTube TikTok Instagram Downloader";
    const pageDescription = activePlatform
      ? `${activePlatform.keyword} free with no login. Use Downvid to download ${activePlatform.label} reels, shorts, clips, and HD social media videos in seconds.`
      : "Download TikTok videos, download Instagram videos, download Pinterest videos, download YouTube videos, and download Facebook videos free with no login.";
    document.title = pageTitle;
    const descriptionMeta = document.querySelector('meta[name="description"]');
    if (descriptionMeta) descriptionMeta.setAttribute("content", pageDescription);
  }, [activePlatform]);

  const startProgressPolling = (id) => {
    let finished = false;
    setLoading(true);
    setProgress(0);
    setStatus("Preparing file...");
    const interval = setInterval(async () => {
      if (finished) return;
      try {
        const response = await fetch(`${API}/api/progress/${id}`);
        if (!response.ok) return;
        const payload = await response.json();
        const currentProgress = payload?.progress;
        if (typeof currentProgress !== "number") return;
        setProgress(Math.max(0, currentProgress));
        if (currentProgress === -1) {
          finished = true;
          clearInterval(interval);
          clearTimeout(timeout);
          setLoading(false);
          setStatus(payload?.error || "Download failed");
          return;
        }
        if (currentProgress >= 100) {
          finished = true;
          clearInterval(interval);
          clearTimeout(timeout);
          setLoading(false);
          setStatus("Download ready");
          setTimeout(() => {
            window.location.href = `${API}/api/file/${id}`;
          }, 300);
        }
      } catch {
        // Ignore transient polling errors.
      }
    }, 500);

    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      clearInterval(interval);
      setLoading(false);
      setStatus("Download timed out");
    }, 150000);
  };

  const handleMediaDownload = async () => {
    if (!url.trim() || loading || searchingMusic) return;
    if (!activePlatform) {
      setStatus("Pick a platform first, then paste the URL.");
      return;
    }
    if (activePlatform && !activePlatform.pattern.test(url.trim())) {
      const suggestedPlatform = platformConfig.find((platform) => platform.pattern.test(url.trim()));
      if (suggestedPlatform) {
        setStatus(`Please use a valid ${activePlatform.label} URL for this platform. Use the platform "${suggestedPlatform.label}" tab instead.`);
      } else {
        setStatus(`Please use a valid ${activePlatform.label} URL for this platform.`);
      }
      return;
    }
    setStatus("Submitting media URL...");
    setProgress(0);
    try {
      const response = await fetch(`${API}/api/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() })
      });
      if (!response.ok) throw new Error(await parseErrorMessage(response));
      const payload = await response.json();
      if (!payload?.id) throw new Error("Invalid response from server");
      setUrl("");
      startProgressPolling(payload.id);
    } catch (error) {
      setStatus(error.message || "Server error");
      setLoading(false);
    }
  };

  const handleMusicSearch = async () => {
    if (musicSearchInFlightRef.current || loading || searchingMusic || !musicQuery.trim()) return;
    musicSearchInFlightRef.current = true;
    setSearchingMusic(true);
    setStatus("Searching songs...");
    setMusicSuggestions([]);
    setLastMusicAttempt(musicQuery.trim());
    try {
      const response = await fetch(`${API}/api/music/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-client-id": clientId },
        body: JSON.stringify({ query: musicQuery.trim() })
      });
      if (!response.ok) throw new Error(await parseErrorMessage(response));
      const payload = await response.json();
      setMusicSessionId(payload.sessionId || "");
      setMusicSuggestions(payload.suggestions || []);
      const count = (payload.suggestions || []).length;
      setStatus(count > 0 ? `Found ${count} song${count > 1 ? "s" : ""}. Select one to download.` : "No songs found. Try a different name.");
      if (count > 0) setMusicQuery("");
    } catch (error) {
      setStatus(error.message || "Music search failed");
    } finally {
      musicSearchInFlightRef.current = false;
      setSearchingMusic(false);
    }
  };

  const handleMusicSelection = async (option) => {
    if (!musicSessionId || !option?.id) return;
    setStatus("Preparing audio...");
    setProgress(0);
    try {
      const response = await fetch(`${API}/api/music/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: musicSessionId, optionId: option.id })
      });
      if (!response.ok) throw new Error(await parseErrorMessage(response));
      const payload = await response.json();
      setMusicSessionId("");
      setMusicSuggestions([]);
      setMusicQuery("");
      startProgressPolling(payload.id);
    } catch (error) {
      setStatus(error.message || "Song download failed");
    }
  };

  const handleRetryMusic = () => {
    if (loading || searchingMusic) return;
    const fallback = lastMusicAttempt.trim();
    if (!musicQuery.trim() && fallback) {
      setMusicQuery(fallback);
      setStatus("Retry query restored. Click Find songs.");
      return;
    }
    if (musicQuery.trim()) {
      handleMusicSearch();
      return;
    }
    setStatus("Type a song or artist name to retry.");
  };

  const handleEnterAction = (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (loading || searchingMusic) return;
    if (mode === MODES.MEDIA) { handleMediaDownload(); return; }
    handleMusicSearch();
  };

  const isWarning = /please use a valid|pick a platform|failed|timed out|error|not found|no songs/i.test(status);

  return (
    <section className="panel">
      <h1 className="panelTitle">
        {activePlatform
          ? `${activePlatform.label} Downloader`
          : "Fast Downloads, No Login"}
      </h1>
      <p className="panelSubtitle">
        {activePlatform
          ? `Paste any ${activePlatform.label} URL below to download videos and images instantly.`
          : "Download videos, images and music from any supported platform. No sign-up, no hassle."}
      </p>

      <div className="platformBar">
        {platformConfig.map((platform) => (
          <Link
            key={platform.key}
            className={`platformChip ${platform.key === platformKey ? "active" : ""} ${mode === MODES.MUSIC ? "disabled" : ""}`}
            to={mode === MODES.MUSIC ? "#" : `/platform/${platform.key}`}
            onClick={(e) => { if (mode === MODES.MUSIC) e.preventDefault(); }}
            aria-disabled={mode === MODES.MUSIC}
          >
            {platform.label}
          </Link>
        ))}
      </div>

      <div className="modeSwitch">
        <button
          className={`modeBtn ${mode === MODES.MEDIA ? "active" : ""}`}
          type="button"
          onClick={() => { setMode(MODES.MEDIA); navigate("/"); }}
        >
          <Download size={14} /> Media
        </button>
        <button
          className={`modeBtn ${mode === MODES.MUSIC ? "active" : ""}`}
          type="button"
          onClick={() => { setMode(MODES.MUSIC); navigate("/music-downloader"); }}
        >
          <Music size={14} /> Music
        </button>
      </div>

      {mode === MODES.MEDIA && (
        <div className="inputGroup">
          {!activePlatform && (
            <p className="platformHint">Select a platform above to get started</p>
          )}
          {activePlatform && (
            <div className="inputRow">
              <input
                className="field"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={handleEnterAction}
                placeholder={`Paste ${activePlatform.label} URL...`}
                disabled={loading || searchingMusic}
              />
              <button
                className="primaryBtn"
                onClick={handleMediaDownload}
                type="button"
                disabled={loading || searchingMusic || !url.trim()}
              >
                {loading ? <Loader size={14} className="shimmer" /> : <Download size={14} />}
                {loading ? "Downloading" : "Download"}
              </button>
            </div>
          )}
        </div>
      )}

      {mode === MODES.MUSIC && (
        <div className="inputGroup">
          <div className="inputRow">
            <input
              className="field"
              type="text"
              value={musicQuery}
              onChange={(e) => setMusicQuery(e.target.value)}
              onKeyDown={handleEnterAction}
              placeholder="Song or artist name..."
              disabled={loading || searchingMusic}
            />
            <button
              className="primaryBtn"
              onClick={handleMusicSearch}
              type="button"
              disabled={loading || searchingMusic || !musicQuery.trim()}
            >
              {searchingMusic ? <Loader size={14} /> : <Search size={14} />}
              {searchingMusic ? "Searching" : "Find"}
            </button>
            <button
              className="primaryBtn secondaryBtn"
              onClick={handleRetryMusic}
              type="button"
              disabled={loading || searchingMusic}
            >
              <RefreshCw size={14} />
            </button>
          </div>

          {musicSuggestions.length > 0 && (
            <div className="songGrid">
              {musicSuggestions.map((song) => (
                <button
                  key={song.id}
                  className="songItem"
                  type="button"
                  onClick={() => handleMusicSelection(song)}
                  disabled={loading || searchingMusic}
                >
                  <span className="songNumber">#{song.id}</span>
                  <span>{song.label}</span>
                  <ArrowRight size={14} style={{ marginLeft: "auto", opacity: 0.4 }} />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {loading && (
        <div className="progressSection">
          <div className="progressTrack">
            <div className="progressFill" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      {status && (
        <p className={`statusLine ${isWarning ? "warning" : progress >= 100 ? "success" : ""}`}>
          {status}
        </p>
      )}
    </section>
  );
}
