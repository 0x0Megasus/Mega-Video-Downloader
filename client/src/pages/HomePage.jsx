import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

const normalizeApiBase = (rawUrl) => {
  const value = (rawUrl || "").trim();
  if (!value) return "http://localhost:5000";
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withProtocol.replace(/\/+$/, "");
};

const MODES = { MEDIA: "media", MUSIC: "music" };
const API = normalizeApiBase(import.meta.env.VITE_API_URL);
const CLIENT_ID_STORAGE_KEY = "mega_downloader_client_id";
const platformConfig = [
  { key: "youtube", label: "YouTube", keyword: "download YouTube videos", pattern: /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i },
  { key: "tiktok", label: "TikTok", keyword: "download TikTok videos", pattern: /^(https?:\/\/)?(www\.)?(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)\//i },
  { key: "instagram", label: "Instagram", keyword: "download Instagram videos", pattern: /^(https?:\/\/)?(www\.)?instagram\.com\//i },
  { key: "facebook", label: "Facebook", keyword: "download Facebook videos", pattern: /^(https?:\/\/)?(www\.)?(facebook\.com|fb\.watch)\//i },
  { key: "pinterest", label: "Pinterest", keyword: "download Pinterest videos", pattern: /^(https?:\/\/)?(www\.)?(pinterest\.[a-z.]{2,}|pin\.it)\//i },
  { key: "x", label: "X / Twitter", keyword: "download X videos", pattern: /^(https?:\/\/)?(www\.)?(x\.com|twitter\.com)\//i },
  { key: "reddit", label: "Reddit", keyword: "download Reddit videos", pattern: /^(https?:\/\/)?(www\.)?reddit\.com\//i }
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
  const [clientId] = useState(() => getClientId());
  const musicSearchInFlightRef = useRef(false);

  useEffect(() => {
    setMode(forceMode === MODES.MUSIC ? MODES.MUSIC : MODES.MEDIA);
  }, [forceMode]);

  useEffect(() => {
    const pageTitle = activePlatform
      ? `Free ${activePlatform.label} Video Downloader | Fast ${activePlatform.label} Download Tool`
      : "Free Video Downloader & Music Downloader | YouTube TikTok Instagram Downloader";
    const pageDescription = activePlatform
      ? `${activePlatform.keyword} free with no login. Use Mega Downloader to download ${activePlatform.label} reels, shorts, clips, and HD social media videos in seconds.`
      : "Download TikTok videos, download Instagram videos, download Pinterest videos, download YouTube videos, and download Facebook videos free with no login.";
    document.title = pageTitle;
    const descriptionMeta = document.querySelector('meta[name="description"]');
    if (descriptionMeta) descriptionMeta.setAttribute("content", pageDescription);
  }, [activePlatform]);

  const startProgressPolling = (id) => {
    let finished = false;
    setLoading(true);
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
        setStatus(`Please use a valid ${activePlatform.label} URL for this route. Use the platform "${suggestedPlatform.label}" tab instead.`);
      } else {
        setStatus(`Please use a valid ${activePlatform.label} URL for this route.`);
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
      setStatus("Select a song from suggestions.");
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
      startProgressPolling(payload.id);
    } catch (error) {
      setStatus(error.message || "Song download failed");
    }
  };

  return (
    <section className="panel">
      <h1>Fast video, image, and music downloads</h1>
      <p className="lead">Download TikTok videos, Instagram reels, Pinterest videos, and YouTube clips in seconds with a fast, free, no-login downloader.</p>
      {mode === MODES.MEDIA && (
        <div className="platformTabs">
          {platformConfig.map((platform) => (
            <Link
              key={platform.key}
              className={`platformTab ${platform.key === platformKey ? "active" : ""}`}
              to={`/platform/${platform.key}`}
            >
              {platform.label}
            </Link>
          ))}
        </div>
      )}
      <div className="modeTabs">
        <button
          className={mode === MODES.MEDIA ? "active" : ""}
          type="button"
          onClick={() => {
            setMode(MODES.MEDIA);
            navigate("/");
          }}
        >
          Media
        </button>
        <button
          className={mode === MODES.MUSIC ? "active" : ""}
          type="button"
          onClick={() => {
            setMode(MODES.MUSIC);
            navigate("/music-downloader");
          }}
        >
          Music
        </button>
      </div>
      {mode === MODES.MEDIA && (
        <div className="stack">
          {!activePlatform && (
            <p className="statusLine platformHint">Please Select the platform you wanna download from.</p>
          )}
          {activePlatform && (
            <>
              <input
                className="field"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={`Paste ${activePlatform.label} URL`}
              />
              <button className="primaryBtn" onClick={handleMediaDownload} type="button" disabled={loading || searchingMusic}>
                Download from {activePlatform.label}
              </button>
            </>
          )}
        </div>
      )}
      {mode === MODES.MUSIC && (
        <div className="stack">
          <input className="field" type="text" value={musicQuery} onChange={(e) => setMusicQuery(e.target.value)} placeholder="Song or artist name" />
          <button className="primaryBtn" onClick={handleMusicSearch} type="button" disabled={loading || searchingMusic}>Find songs</button>
          <div className="songGrid">
            {musicSuggestions.map((song) => (
              <button key={song.id} className="songItem" type="button" onClick={() => handleMusicSelection(song)}>
                {song.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {loading && (
        <div className="progress">
          <div className="progressBar" style={{ width: `${progress}%` }} />
        </div>
      )}
      <p className={`statusLine ${/please use a valid|pick a platform|failed|timed out|error/i.test(status) ? "warning" : ""}`}>{status}</p>
    </section>
  );
}
