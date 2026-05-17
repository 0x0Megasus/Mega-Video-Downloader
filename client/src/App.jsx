import { useEffect, useRef, useState } from "react";
import "./App.css";

const normalizeApiBase = (rawUrl) => {
  const value = (rawUrl || "").trim();
  if (!value) return "http://localhost:5000";

  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withProtocol.replace(/\/+$/, "");
};

const MODES = {
  MEDIA: "media",
  MUSIC: "music",
  INFO: "info"
};

const platformPatterns = [
  { name: "YouTube", pattern: /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/ },
  { name: "TikTok", pattern: /^(https?:\/\/)?(www\.)?(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)\/.+$/ },
  { name: "Instagram", pattern: /^(https?:\/\/)?(www\.)?(instagram\.com)\/.+$/ },
  { name: "Facebook", pattern: /^(https?:\/\/)?(www\.)?(facebook\.com|fb\.watch)\/.+$/ },
  { name: "Pinterest", pattern: /^(https?:\/\/)?(www\.)?(pin\.it|pinterest\.com|pinterest\.ca|pinterest\.co\.uk|pinterest\.ph|pinterest\.fr|pinterest\.de)\/.+$/ },
  { name: "Twitter/X", pattern: /^(https?:\/\/)?(www\.)?(twitter\.com|x\.com)\/.+$/ },
  { name: "Reddit", pattern: /^(https?:\/\/)?(www\.)?(reddit\.com)\/.+$/ },
  { name: "Vimeo", pattern: /^(https?:\/\/)?(www\.)?(vimeo\.com)\/.+$/ },
  { name: "Dailymotion", pattern: /^(https?:\/\/)?(www\.)?(dailymotion\.com)\/.+$/ }
];

const parseErrorMessage = async (response) => {
  const fallback = "Server error";
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const data = await response.json();
    return data?.error || fallback;
  }

  const text = await response.text();
  return text || fallback;
};

const CLIENT_ID_STORAGE_KEY = "mega_downloader_client_id";

const getClientId = () => {
  if (typeof window === "undefined") return "unknown_client";

  const existing = window.localStorage.getItem(CLIENT_ID_STORAGE_KEY);
  if (existing) return existing;

  const generated = window.crypto?.randomUUID?.()
    || `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, generated);
  return generated;
};

const isControlSongSuggestion = (label = "") => {
  const value = (label || "")
    .replace(/^#?\d+[.)-]?\s*/u, "")
    .replace(/^[^\p{L}\p{N}]+/gu, "")
    .trim()
    .toLowerCase();

  if (!value) return true;
  if (!/[\p{L}\p{N}]/u.test(value)) return true;
  if (/(^|\s)(more tracks|add to group|next|previous|prev|back|menu|start|help)($|\s)/i.test(value)) return true;

  return false;
};

const getDownloadPhaseStatus = (progress, itemLabel = "file") => {
  if (progress < 10) return `Connecting to source for your ${itemLabel}...`;
  if (progress < 40) return `Fetching your ${itemLabel}...`;
  if (progress < 85) return `Preparing your ${itemLabel}...`;
  return `Finalizing your ${itemLabel}...`;
};

const BENEFIT_ITEMS = [
  "Free to use with no login required",
  "Music search by title or artist name",
  "Fast download pipeline with real-time progress",
  "Works on desktop and mobile browsers"
];

const SUPPORTED_PLATFORMS = [
  "YouTube",
  "TikTok",
  "Instagram",
  "Pinterest",
  "Facebook",
  "Twitter/X",
  "Reddit",
  "Vimeo",
  "Dailymotion"
];

const FAQ_ITEMS = [
  {
    question: "Do I need to create an account?",
    answer: "No. Downvid is available with no sign-up and no login."
  },
  {
    question: "Can I search music by artist name?",
    answer: "Yes. Use Music mode, type the song title or artist name, and pick from the suggested tracks."
  },
  {
    question: "What can I download?",
    answer: "The app supports downloading videos, images, and audio from supported sources."
  }
];

export default function App() {
  const [mode, setMode] = useState(MODES.MEDIA);
  const [url, setUrl] = useState("");
  const [musicQuery, setMusicQuery] = useState("");
  const [musicSessionId, setMusicSessionId] = useState("");
  const [musicSuggestions, setMusicSuggestions] = useState([]);
  const [activeSongLabel, setActiveSongLabel] = useState("");
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searchingMusic, setSearchingMusic] = useState(false);
  const [clientId] = useState(() => getClientId());
  const musicSearchInFlightRef = useRef(false);

  const API = normalizeApiBase(import.meta.env.VITE_API_URL);

  useEffect(() => {
    let nextTitle = "Downvid | Free Video & Image Downloader (No Login)";
    let nextDescription = "Download videos and images for free with no login on Downvid.";

    if (mode === MODES.MUSIC) {
      nextTitle = "Downvid | Free Music Downloader by Song or Artist";
      nextDescription = "Search songs by title or artist name, then download music for free with no login.";
    }

    if (mode === MODES.INFO) {
      nextTitle = "Downvid | Why Use Downvid";
      nextDescription = "See why Downvid is fast, free, no-login, and built for music, video, and image downloads.";
    }

    document.title = nextTitle;

    const descriptionMeta = document.querySelector('meta[name="description"]');
    if (descriptionMeta) {
      descriptionMeta.setAttribute("content", nextDescription);
    }
  }, [mode]);

  const validateUrl = (inputValue) => {
    const cleanUrl = (inputValue || "").trim();

    if (!cleanUrl) {
      return { valid: false, message: "URL is required" };
    }

    try {
      new URL(cleanUrl);
    } catch {
      return { valid: false, message: "Invalid URL format" };
    }

    for (const platform of platformPatterns) {
      if (platform.pattern.test(cleanUrl)) {
        return { valid: true, platform: platform.name };
      }
    }

    return { valid: false, message: "URL not from a supported platform" };
  };

  const startProgressPolling = (
    id,
    {
      itemLabel = "file",
      startMessage = "Request accepted. Preparing your file...",
      completeMessage = "Download complete! Starting download..."
    } = {}
  ) => {
    let finished = false;

    setLoading(true);
    setProgress(0);
    setStatus(startMessage);

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
          setStatus(payload?.error || "Download failed ❌");
          return;
        }

        if (currentProgress >= 100) {
          finished = true;
          clearInterval(interval);
          clearTimeout(timeout);
          setLoading(false);
          setStatus(completeMessage);

          setTimeout(() => {
            window.location.href = `${API}/api/file/${id}`;
          }, 400);

          return;
        }

        setStatus(getDownloadPhaseStatus(currentProgress, itemLabel));
      } catch {
        // Ignore transient polling errors.
      }
    }, 500);

    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      clearInterval(interval);
      setLoading(false);
      setStatus("Download timed out ❌");
    }, 150000);
  };

  const handleMediaDownload = async () => {
    if (loading || searchingMusic) return;

    const validation = validateUrl(url);
    if (!validation.valid) {
      setStatus(`${validation.message} ❌`);
      return;
    }

    setStatus(`Sending ${validation.platform} link...`);
    setProgress(0);

    try {
      const response = await fetch(`${API}/api/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() })
      });

      if (!response.ok) {
        throw new Error(await parseErrorMessage(response));
      }

      const payload = await response.json();
      if (!payload?.id) {
        throw new Error("Invalid response from server");
      }

      startProgressPolling(payload.id, {
        itemLabel: "media file",
        startMessage: "Source accepted. Preparing your media file...",
        completeMessage: "Media ready! Starting download..."
      });
    } catch (error) {
      setStatus(`${error.message || "Server error"} ❌`);
      setLoading(false);
    }
  };

  const handleMusicSearch = async () => {
    if (musicSearchInFlightRef.current || loading || searchingMusic) return;

    const query = musicQuery.trim();
    if (!query) {
      setStatus("Song name or singer name is required ❌");
      return;
    }

    musicSearchInFlightRef.current = true;
    setSearchingMusic(true);
    setStatus("Searching songs...");
    setMusicSuggestions([]);
    setMusicSessionId("");
    setActiveSongLabel("");

    try {
      const response = await fetch(`${API}/api/music/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-client-id": clientId
        },
        body: JSON.stringify({ query })
      });

      if (!response.ok) {
        throw new Error(await parseErrorMessage(response));
      }

      const payload = await response.json();
      const suggestions = Array.isArray(payload?.suggestions)
        ? payload.suggestions.filter((option) => !isControlSongSuggestion(option?.label))
        : [];

      if (!payload?.sessionId || suggestions.length === 0) {
        throw new Error("No songs were found. Try another name.");
      }

      setMusicSessionId(payload.sessionId);
      setMusicSuggestions(suggestions);
      setStatus(`Found ${suggestions.length} songs. Select one to download.`);
    } catch (error) {
      setStatus(`${error.message || "Music search failed"} ❌`);
    } finally {
      musicSearchInFlightRef.current = false;
      setSearchingMusic(false);
    }
  };

  const handleMusicSelection = async (option) => {
    if (!option || loading || searchingMusic) return;

    if (!musicSessionId) {
      setStatus("Search for songs first ❌");
      return;
    }

    setActiveSongLabel(option.label);
    setMusicQuery("");
    setStatus(`"${option.label}" selected. Requesting audio file...`);
    setProgress(0);

    try {
      const response = await fetch(`${API}/api/music/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: musicSessionId,
          optionId: option.id
        })
      });

      if (!response.ok) {
        throw new Error(await parseErrorMessage(response));
      }

      const payload = await response.json();
      if (!payload?.id) {
        throw new Error("Invalid server response");
      }

      setMusicSessionId("");
      setMusicSuggestions([]);
      startProgressPolling(payload.id, {
        itemLabel: "song",
        startMessage: "Song found. Preparing audio file...",
        completeMessage: `Song ready! Starting download for "${option.label}"...`
      });
    } catch (error) {
      setStatus(`${error.message || "Song download failed"} ❌`);
      setLoading(false);
    }
  };

  const switchMode = (nextMode) => {
    if (loading || searchingMusic) return;

    setMode(nextMode);
    setStatus("");
    setProgress(0);

    if (nextMode === MODES.MEDIA) {
      setActiveSongLabel("");
    }
  };

  const handleKeyDown = (event) => {
    if (event.key !== "Enter") return;

    if (mode === MODES.MEDIA) {
      handleMediaDownload();
    } else if (mode === MODES.MUSIC) {
      handleMusicSearch();
    }
  };

  return (
    <div className="wrapper">
      <div className="card">
        <div className="navbar" role="tablist" aria-label="Download modes">
          <button
            className={`navButton ${mode === MODES.MEDIA ? "active" : ""}`}
            onClick={() => switchMode(MODES.MEDIA)}
            type="button"
          >
            Video & Images
          </button>
          <button
            className={`navButton ${mode === MODES.MUSIC ? "active" : ""}`}
            onClick={() => switchMode(MODES.MUSIC)}
            type="button"
          >
            Music
          </button>
          <button
            className={`navButton ${mode === MODES.INFO ? "active" : ""}`}
            onClick={() => switchMode(MODES.INFO)}
            type="button"
          >
            About
          </button>
        </div>

        <h1 className="title">Downvid</h1>

        {mode === MODES.MEDIA && (
          <p className="subtitle">
            Download <b>videos & images</b> from <b>YouTube, TikTok, Instagram, Pinterest, Facebook, Twitter/X</b> and more.
          </p>
        )}

        {mode === MODES.MUSIC && (
          <p className="subtitle">
            Search any song by <b>title or singer name</b>, pick from the suggested results, and download it instantly with no login.
          </p>
        )}

        {mode === MODES.INFO && (
          <p className="subtitle">
            Learn what makes Downvid clean, fast, and reliable for daily use.
          </p>
        )}

        {mode === MODES.MEDIA && (
          <>
            <input
              className="input"
              type="url"
              placeholder="Paste video or image URL here..."
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={handleKeyDown}
              disabled={loading || searchingMusic}
            />
            <button
              className="button"
              onClick={handleMediaDownload}
              disabled={loading || searchingMusic}
              type="button"
            >
              {loading ? "Please wait..." : "Download"}
            </button>

            <p className="note">Pinterest supports both images and videos.
            <span><br />TikTok supports both regular and short links.</span>
            </p>
          </>
        )}

        {mode === MODES.MUSIC && (
          <>
            <input
              className="input"
              type="text"
              placeholder="Type song or singer name..."
              value={musicQuery}
              onChange={(event) => setMusicQuery(event.target.value)}
              onKeyDown={handleKeyDown}
              disabled={loading || searchingMusic}
            />
            <button
              className="button"
              onClick={handleMusicSearch}
              disabled={loading || searchingMusic}
              type="button"
            >
              {searchingMusic ? "Searching..." : loading ? "Please wait..." : "Find Songs"}
            </button>

            {musicSuggestions.length > 0 && (
              <div className="songListWrapper">
                <p className="songListTitle">Suggested songs</p>
                <div className="songList">
                  {musicSuggestions.map((option) => (
                    <button
                      key={option.id}
                      className={`songOption ${activeSongLabel === option.label ? "selected" : ""}`}
                      type="button"
                      onClick={() => handleMusicSelection(option)}
                      disabled={loading || searchingMusic}
                    >
                      <span className="songOptionId">#{option.id}</span>
                      <span className="songOptionLabel">{option.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {mode === MODES.INFO && (
          <section className="seoSections" aria-label="Downvid details">
            <article className="seoCard">
              <h2>Why Downvid</h2>
              <p>
                Downvid gives you premium-style features without friction: free usage, no login,
                instant song search, and quick download flow.
              </p>
              <ul className="seoList">
                {BENEFIT_ITEMS.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </article>

            <article className="seoCard">
              <h2>Supported Platforms</h2>
              <p>Use one tool for multiple sources and switch between media and music modes instantly.</p>
              <p className="platformLine">{SUPPORTED_PLATFORMS.join(" • ")}</p>
            </article>

            <article className="seoCard">
              <h2>FAQ</h2>
              {FAQ_ITEMS.map((faq) => (
                <details className="faqItem" key={faq.question}>
                  <summary>{faq.question}</summary>
                  <p>{faq.answer}</p>
                </details>
              ))}
            </article>
          </section>
        )}

        {mode !== MODES.INFO && loading && (
          <div className="progressContainer">
            <div className="progressBarWrapper">
              <div className="progressBarFill" style={{ width: `${progress}%` }}></div>
            </div>
            <span className="progressPercentage">{progress}%</span>
          </div>
        )}

        {mode !== MODES.INFO && (loading || searchingMusic) && (
          <div className="loaderWrapper">
            <div className="spinner"></div>
            <span className="loadingText">{status}</span>
          </div>
        )}

        {mode !== MODES.INFO && !loading && !searchingMusic && <p className="status">{status}</p>}
      </div>
    </div>
  );
}
