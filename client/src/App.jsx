import { useState } from "react";
import "./App.css";

export default function App() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  const [platform, setPlatform] = useState("");

  const API = import.meta.env.VITE_API_URL || "http://localhost:5000";
  // Platform patterns
  const platformPatterns = [
    { name: "YouTube", pattern: /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/ },
    { name: "TikTok", pattern: /^(https?:\/\/)?(www\.)?(tiktok\.com|vm\.tiktok\.com)\/.+$/ },
    { name: "Instagram", pattern: /^(https?:\/\/)?(www\.)?(instagram\.com)\/.+$/ },
    { name: "Facebook", pattern: /^(https?:\/\/)?(www\.)?(facebook\.com|fb\.watch)\/.+$/ },
    { name: "Pinterest", pattern: /^(https?:\/\/)?(www\.)?(pin\.it|pinterest\.com|pinterest\.ca|pinterest\.co\.uk|pinterest\.ph|pinterest\.fr|pinterest\.de)\/.+$/ },
    { name: "Twitter/X", pattern: /^(https?:\/\/)?(www\.)?(twitter\.com|x\.com)\/.+$/ },
    { name: "Reddit", pattern: /^(https?:\/\/)?(www\.)?(reddit\.com)\/.+$/ },
    { name: "Vimeo", pattern: /^(https?:\/\/)?(www\.)?(vimeo\.com)\/.+$/ },
    { name: "Dailymotion", pattern: /^(https?:\/\/)?(www\.)?(dailymotion\.com)\/.+$/ }
  ];

  const resetUI = () => {
    setUrl("");
    setStatus("");
    setProgress(0);
    setLoading(false);
    setPlatform("");
  };

  const validateUrl = (url) => {
    if (!url) return { valid: false, message: "URL is required" };

    const cleanUrl = url.trim();

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

  const download = async () => {
    const validation = validateUrl(url);
    
    if (!validation.valid) {
      setStatus(validation.message + " ❌");
      return;
    }

    setPlatform(validation.platform);
    setStatus(`Processing ${validation.platform}...`);
    setLoading(true);
    setProgress(0);

    try {
      // Start download
      const res = await fetch(`${API}/api/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() })
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Server error");
      }

      const data = await res.json();
      const id = data.id;

      // Poll for progress
      const interval = setInterval(async () => {
        try {
          const progressRes = await fetch(`${API}/api/progress/${id}`);
          
          if (progressRes.ok) {
            const progressData = await progressRes.json();
            const currentProgress = progressData.progress;
            
            setProgress(currentProgress);
            
            if (currentProgress === -1) {
              clearInterval(interval);
              setStatus("Download failed ❌");
              setLoading(false);
            } 
            else if (currentProgress >= 100) {
              clearInterval(interval);
              setStatus("Download complete! Starting download...");
              
              // Small delay to ensure file is ready
              setTimeout(() => {
                window.location.href = `${API}/api/file/${id}`;
                // Reset UI after download starts
                setTimeout(resetUI, 3000);
              }, 500);
            }
            else {
              setStatus(`Downloading: ${currentProgress}%`);
            }
          } else {
            console.log("Progress check failed:", progressRes.status);
          }
        } catch (error) {
          console.log("Progress check error:", error);
        }
      }, 500);

      // Clean up interval after 2 minutes (timeout)
      setTimeout(() => {
        clearInterval(interval);
        if (loading) {
          setStatus("Download timed out ❌");
          setLoading(false);
        }
      }, 120000);

    } catch (error) {
      setStatus(error.message || "Server error ❌");
      setLoading(false);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === "Enter" && !loading) {
      download();
    }
  };

  return (
    <div className="wrapper">
      <div className="card">
        <h1 className="title">Mega Video Downloader</h1>
        <p className="subtitle">
          Download <b>videos & images</b> from <b>YouTube, TikTok, Instagram, Pinterest, Facebook, Twitter(X)</b> and more
        </p>

        <input
          className="input"
          type="url"
          placeholder="Paste Video URL Here..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyPress={handleKeyPress}
          disabled={loading}
        />

        <button
          className="button"
          onClick={download}
          disabled={loading}
        >
          {loading ? `Downloading ${progress}%` : "Download"}
        </button>

        {/* Progress Bar */}
        {loading && (
          <div className="progressContainer">
            <div className="progressBarWrapper">
              <div 
                className="progressBarFill" 
                style={{ width: `${progress}%` }}
              ></div>
            </div>
            <span className="progressPercentage">{progress}%</span>
          </div>
        )}

        {loading && (
          <div className="loaderWrapper">
            <div className="spinner"></div>
            <span className="loadingText">{status}</span>
          </div>
        )}

        {!loading && <p className="status">{status}</p>}
        <p className="note">📷 Pinterest: Supports both images and videos</p>
        <p className="note">🎥 TikTok: Supports both regular and short links (vm.tiktok.com)</p>
      </div>
    </div>
  );
}