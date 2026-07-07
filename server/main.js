import express from "express";
import dotenv from "dotenv";
import dns from "dns";
import net from "net";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { Api } from "telegram/tl/index.js";

dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '1.1.1.1']);

dotenv.config();


// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  PORT: parseInt(process.env.PORT || "5000", 10),
  MUSIC_SESSION_TTL_MS: 5 * 60 * 1000,
  MUSIC_SEARCH_TIMEOUT_MS: 45000,
  MUSIC_DOWNLOAD_TIMEOUT_MS: 150000,
  MEDIA_DOWNLOAD_TIMEOUT_MS: 120000,
  MAP_CLEANUP_INTERVAL_MS: 60000,
  KEEPALIVE_INTERVAL_MS: 45000,
  MAX_FILES: 500,
  MAX_PROGRESS_ENTRIES: 1000,
  MAX_PENDING_MESSAGES: 200,
  MAX_MUSIC_SESSIONS: 100,
  MAX_INFLIGHT_SEARCHES: 50,
  MAX_FILE_AGE_MS: 10 * 60 * 1000,
  MAX_PROGRESS_AGE_MS: 10 * 60 * 1000,
  RATE_LIMIT_WINDOW_MS: 10000,
  RATE_LIMIT_MAX_REQUESTS: 20,
  RATE_LIMIT_BURST: 5,
  REQUEST_TIMEOUT_MS: 30000,
  TELEGRAM_CONNECTION_RETRIES: 2,
  TELEGRAM_TIMEOUT: 15,
  TELEGRAM_DC: { id: 4, ip: "149.154.167.91", port: 443 },
  GRACEFUL_SHUTDOWN_TIMEOUT_MS: 10000,
};

const app = express();

// ============================================
// CORS
// ============================================
const normalizeOrigin = (origin = "") => {
  const value = String(origin || "").trim().toLowerCase();
  return value.replace(/\/+$/, "");
};

const allowedOrigins = [
  process.env.CLIENT_URL || "",
  "https://mega-video-downloader.vercel.app",
  "https://www.downvid.online",
  "http://localhost:5173",
  "http://localhost:3000",
]
  .flatMap((entry) => String(entry).split(","))
  .map((origin) => normalizeOrigin(origin))
  .filter(Boolean);

app.use(express.json({ limit: "100kb" }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();

  const isAllowed = allowedOrigins.length === 0 || allowedOrigins.includes(normalizeOrigin(origin));
  if (!isAllowed) {
    return res.status(403).json({ error: "Not allowed by CORS" });
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      req.headers["access-control-request-headers"] || "Content-Type"
    );
    return res.sendStatus(204);
  }

  next();
});

// ============================================
// RATE LIMITER
// ============================================
const rateLimitStore = new Map();

const rateLimiter = (req, res, next) => {
  const key = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  let entry = rateLimitStore.get(key);

  if (!entry || now - entry.windowStart > CONFIG.RATE_LIMIT_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    rateLimitStore.set(key, entry);
  }

  entry.count++;

  if (entry.count > CONFIG.RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({ error: "Too many requests. Please slow down." });
  }

  next();
};

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now - entry.windowStart > CONFIG.RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitStore.delete(key);
    }
  }
}, CONFIG.MAP_CLEANUP_INTERVAL_MS);



// ============================================
// REQUEST TIMEOUT
// ============================================
const requestTimeout = (timeoutMs = CONFIG.REQUEST_TIMEOUT_MS) => {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        res.status(408).json({ error: "Request timed out" });
      }
    }, timeoutMs);

    res.on("finish", () => clearTimeout(timer));
    res.on("close", () => clearTimeout(timer));
    next();
  };
};

// ============================================
// APP MIDDLEWARE
// ============================================
app.use(rateLimiter);
app.use(requestTimeout());

// ============================================
// STATE WITH SIZE BOUNDS & AUTO-CLEANUP
// ============================================
class BoundedMap {
  #map = new Map();
  #maxSize;
  #ttlMs;
  #cleanupInterval;

  constructor(maxSize = 1000, ttlMs = 10 * 60 * 1000) {
    this.#maxSize = maxSize;
    this.#ttlMs = ttlMs;

    this.#cleanupInterval = setInterval(() => {
      this.#evictStale();
    }, CONFIG.MAP_CLEANUP_INTERVAL_MS);

    if (this.#cleanupInterval.unref) this.#cleanupInterval.unref();
  }

  get size() { return this.#map.size; }

  get(key) {
    const entry = this.#map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.#ttlMs) {
      this.#map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    if (this.#map.size >= this.#maxSize) {
      this.#evictOldest();
    }
    this.#map.set(key, { value, ts: Date.now() });
    return this;
  }

  delete(key) {
    return this.#map.delete(key);
  }

  has(key) {
    const entry = this.#map.get(key);
    if (!entry) return false;
    if (Date.now() - entry.ts > this.#ttlMs) {
      this.#map.delete(key);
      return false;
    }
    return true;
  }

  entries() {
    this.#evictStale();
    const result = [];
    for (const [key, entry] of this.#map.entries()) {
      result.push([key, entry.value]);
    }
    return result;
  }

  keys() {
    this.#evictStale();
    return this.#map.keys();
  }

  #evictStale() {
    const now = Date.now();
    for (const [key, entry] of this.#map.entries()) {
      if (now - entry.ts > this.#ttlMs) {
        this.#map.delete(key);
      }
    }
  }

  #evictOldest() {
    let oldestKey = null;
    let oldestTs = Infinity;
    for (const [key, entry] of this.#map.entries()) {
      if (entry.ts < oldestTs) {
        oldestTs = entry.ts;
        oldestKey = key;
      }
    }
    if (oldestKey) this.#map.delete(oldestKey);
  }

  destroy() {
    clearInterval(this.#cleanupInterval);
    this.#map.clear();
  }
}

const files = new BoundedMap(CONFIG.MAX_FILES, CONFIG.MAX_FILE_AGE_MS);
const progressMap = new BoundedMap(CONFIG.MAX_PROGRESS_ENTRIES, CONFIG.MAX_PROGRESS_AGE_MS);
const pendingMessages = new Map();
const musicSearchSessions = new BoundedMap(CONFIG.MAX_MUSIC_SESSIONS, CONFIG.MUSIC_SESSION_TTL_MS);
const inFlightMusicSearches = new Map();
const musicEventHandlers = new Map();

const TELEGRAM_LOCK = { locked: false, queue: [] };

// ============================================
// PLATFORM VALIDATION
// ============================================
const platformValidators = [
  {
    name: "YouTube",
    patterns: [
      /^(https?:\/\/)?(www\.)?youtube\.com\/watch\?v=[\w-]+/,
      /^(https?:\/\/)?(www\.)?youtube\.com\/shorts\/[\w-]+/,
      /^(https?:\/\/)?(www\.)?youtu\.be\/[\w-]+/,
    ],
  },
  {
    name: "TikTok",
    patterns: [
      /^(https?:\/\/)?(www\.)?tiktok\.com\/@[\w.-]+\/video\/\d+/,
      /^(https?:\/\/)?(www\.)?tiktok\.com\/[\w-]+/,
      /^(https?:\/\/)?(vm\.tiktok\.com)\/[\w-]+/,
      /^(https?:\/\/)?(vt\.tiktok\.com)\/[\w-]+/,
    ],
  },
  {
    name: "Instagram",
    patterns: [
      /^(https?:\/\/)?(www\.)?instagram\.com\/(p|reel|tv)\/[\w-]+/,
      /^(https?:\/\/)?(www\.)?instagram\.com\/[\w-]+\/?/,
    ],
  },
  {
    name: "Facebook",
    patterns: [
      /^(https?:\/\/)?(www\.)?facebook\.com\/.*\/videos\/\d+/,
      /^(https?:\/\/)?(www\.)?facebook\.com\/watch\/?\?v=\d+/,
      /^(https?:\/\/)?(www\.)?fb\.watch\/[\w-]+/,
    ],
  },
  {
    name: "Pinterest",
    patterns: [
      /^(https?:\/\/)?(www\.)?pin\.it\/[\w-]+/,
      /^(https?:\/\/)?(www\.)?pinterest\.[a-z.]{2,}\/pin\/[\w-]+/,
      /^(https?:\/\/)?(www\.)?pinterest\.[a-z.]{2,}\/[\w-]+\/[\w-]+\/\d+/,
      /^(https?:\/\/)?(www\.)?pinterest\.[a-z.]{2,}\/[\w-]+\/[\w-]+$/,
      /^(https?:\/\/)?(www\.)?pinterest\.[a-z.]{2,}\/pin\/\d+/,
      /^(https?:\/\/)?(www\.)?pinterest\.[a-z.]{2,}\/[\w-]+\/\d+$/,
    ],
  },
  {
    name: "Twitter/X",
    patterns: [
      /^(https?:\/\/)?(www\.)?twitter\.com\/\w+\/status\/\d+/,
      /^(https?:\/\/)?(www\.)?x\.com\/\w+\/status\/\d+/,
    ],
  },
  {
    name: "Reddit",
    patterns: [
      /^(https?:\/\/)?(www\.)?reddit\.com\/r\/\w+\/comments\/\w+\/[\w-]+/,
    ],
  },
  {
    name: "Vimeo",
    patterns: [
      /^(https?:\/\/)?(www\.)?vimeo\.com\/\d+/,
    ],
  },
  {
    name: "Dailymotion",
    patterns: [
      /^(https?:\/\/)?(www\.)?dailymotion\.com\/video\/[\w-]+/,
    ],
  },
];

const isValidUrl = (string) => {
  try { new URL(string); return true; }
  catch { return false; }
};

const getPlatformFromUrl = (url) => {
  for (const platform of platformValidators) {
    for (const pattern of platform.patterns) {
      if (pattern.test(url)) return platform.name;
    }
  }
  return null;
};

const createId = (prefix = "") => {
  const base = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return prefix ? `${prefix}_${base}` : base;
};

const sanitizeLabel = (value = "") => {
  return value
    .replace(/\s+/g, " ")
    .replace(/[\u200E\u200F]/g, "")
    .trim();
};

const deriveFileExtension = (doc, mimeType = "") => {
  const attributes = doc?.attributes || [];
  const fileNameAttr = attributes.find((attr) => attr?.fileName);
  const fileName = fileNameAttr?.fileName || "";
  if (fileName.includes(".")) {
    const ext = fileName.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "");
    if (ext) return ext;
  }
  if (mimeType.includes("/")) {
    const mimeExt = mimeType.split("/")[1].split(";")[0].toLowerCase().trim();
    if (mimeExt) return mimeExt === "mpeg" ? "mp3" : mimeExt;
  }
  return "bin";
};

const normalizeMime = (mimeType = "", fallbackType = "application/octet-stream") => {
  if (!mimeType || !mimeType.includes("/")) return fallbackType;
  return mimeType;
};

// ============================================
// MUSIC HELPERS
// ============================================
const flattenReplyButtons = (msg) => {
  const rows = msg?.replyMarkup?.rows || [];
  const options = [];

  for (const row of rows) {
    const buttons = row?.buttons || [];
    for (const button of buttons) {
      const text = sanitizeLabel(button?.text || "");
      if (!text) continue;

      if (button?.data !== undefined && button?.data !== null) {
        options.push({ label: text, action: { type: "callback", data: button.data } });
      } else {
        options.push({ label: text, action: { type: "text", text } });
      }
    }
  }

  return options;
};

const parseMusicOptionsFromText = (text = "") => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => sanitizeLabel(line))
    .filter(Boolean);

  const options = [];

  for (const line of lines) {
    const numberedMatch = line.match(/^(\d+)[\.\)-]\s*(.+)$/);
    if (numberedMatch?.[2]) {
      options.push({ label: numberedMatch[2].trim(), action: { type: "text", text: numberedMatch[1] } });
    }
  }

  return options;
};

const normalizeMusicOptionLabel = (label = "") => {
  return sanitizeLabel(label)
    .replace(/^#?\d+[.)-]?\s*/u, "")
    .replace(/^[^\p{L}\p{N}]+/gu, "")
    .trim();
};

const SYSTEM_MUSIC_BUTTON_PATTERNS = [
  /^create your own bot$/i, /^add to group$/i, /^\+?\s*add to group$/i,
  /^\+?\s*more tracks$/i, /^more tracks$/i, /^search$/i, /^open app$/i,
  /^start$/i, /^help$/i, /^settings$/i, /^about$/i, /^support$/i,
  /^feedback$/i, /^privacy$/i, /^terms$/i, /^next$/i, /^previous$/i,
  /^prev$/i, /^back$/i, /^menu$/i,
];

const isSystemMusicButton = (label = "") => {
  const clean = normalizeMusicOptionLabel(label);
  if (!clean) return true;
  if (!/[\p{L}\p{N}]/u.test(clean)) return true;
  return SYSTEM_MUSIC_BUTTON_PATTERNS.some((pattern) => pattern.test(clean));
};

const filterMusicOptions = (options = [], query = "") => {
  const queryTokens = sanitizeLabel(query)
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length >= 2);

  return options.filter((option) => {
    const label = normalizeMusicOptionLabel(option?.label || "");
    if (!label || isSystemMusicButton(label)) return false;

    const lower = label.toLowerCase();
    if (/@\w+bot\b/.test(lower)) return false;
    if (/\b(add to group|more tracks|next|previous|prev|back)\b/i.test(lower)) return false;

    if (/\bbot\b/.test(lower) && queryTokens.length > 0) {
      const includesQuery = queryTokens.some((token) => lower.includes(token));
      if (!includesQuery) return false;
    }

    return true;
  });
};

const serializeMusicOptions = (options = []) => {
  return options.map((option, index) => ({
    id: String(index + 1),
    label: option.label,
  }));
};

const buildMusicSearchKey = (req, query) => {
  const headerClientId = sanitizeLabel(String(req.headers["x-client-id"] || ""));
  const sourceClientId = headerClientId || sanitizeLabel(req.ip || req.socket?.remoteAddress || "unknown_client");
  return `${sourceClientId.toLowerCase()}::${query.toLowerCase()}`;
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

// ============================================
// TELEGRAM CONNECTION
// ============================================
let client = null;
let bot = null;
let ready = false;
let connectionAttempts = 0;
let reconnectTimer = null;
let keepAliveTimer = null;
let reconnectionInProgress = false;

const TELEGRAM_DC = CONFIG.TELEGRAM_DC;

function triggerReconnect() {
  if (reconnectionInProgress) return;
  reconnectionInProgress = true;
  ready = false;
  console.log("🔄 Initiating reconnection...");
  connectTelegram();
}

async function connectTelegram() {
  reconnectionInProgress = true;
  try {
    connectionAttempts++;
    console.log(`🔌 Connecting to Telegram DC${TELEGRAM_DC.id} (attempt ${connectionAttempts})...`);

    const socket = new net.Socket();
    const connectionTest = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 5000);

      socket.connect(TELEGRAM_DC.port, TELEGRAM_DC.ip, () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });

      socket.on("error", () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(false);
      });
    });

    if (!connectionTest) {
      throw new Error(`Cannot reach ${TELEGRAM_DC.ip}:${TELEGRAM_DC.port}`);
    }

    console.log("✅ Network connection successful");

    const newClient = new TelegramClient(
      new StringSession(process.env.SESSION || ""),
      Number(process.env.API_ID),
      process.env.API_HASH,
      {
        connectionRetries: CONFIG.TELEGRAM_CONNECTION_RETRIES,
        useWSS: false,
        baseDc: TELEGRAM_DC.id,
        ipVersion: 4,
        timeout: CONFIG.TELEGRAM_TIMEOUT,
      }
    );

    newClient.session.setDC(TELEGRAM_DC.id, TELEGRAM_DC.ip, TELEGRAM_DC.port);
    await newClient.connect();

    if (!(await newClient.isUserAuthorized())) {
      throw new Error("Session expired - need new login");
    }

    const newBot = await newClient.getEntity(process.env.BOT_USERNAME);

    client = newClient;
    bot = newBot;
    ready = true;
    connectionAttempts = 0;
    reconnectionInProgress = false;

    console.log("✅ Telegram ready and connected!");
  } catch (error) {
    console.error("❌ Connection error:", error.message);
    ready = false;

    const delay = Math.min(5000 * connectionAttempts, 30000);
    console.log(`⏰ Retrying in ${delay / 1000} seconds...`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectTelegram();
    }, delay);
  } finally {
    reconnectionInProgress = false;
  }
}

startKeepAlive();

function startKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);

  let keepAliveFailures = 0;

  keepAliveTimer = setInterval(async () => {
    if (client) {
      try {
        await Promise.race([
          client.invoke(new Api.ping.Ping({ ping_id: BigInt(Date.now()) })),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Ping timeout")), 5000)),
        ]);
        keepAliveFailures = 0;
        if (!ready) {
          console.log("✅ Connection restored, marking as ready");
          ready = true;
        }
      } catch {
        keepAliveFailures++;
        if (ready) {
          console.log(`💓 Keep-alive failed (attempt ${keepAliveFailures})`);
          ready = false;
        }
        if (keepAliveFailures >= 3) {
          console.log("⚠️ Keep-alive: too many failures, triggering reconnect");
          keepAliveFailures = 0;
          triggerReconnect();
        }
      }
    }
  }, CONFIG.KEEPALIVE_INTERVAL_MS);

  if (keepAliveTimer.unref) keepAliveTimer.unref();
}

async function ensureConnection() {
  if (!client) {
    triggerReconnect();
    throw new Error("Service is busy right now. Please try again shortly.");
  }
  if (!ready) {
    try {
      await Promise.race([
        client.invoke(new Api.ping.Ping({ ping_id: BigInt(Date.now()) })),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Ping timeout")), 5000)),
      ]);
      ready = true;
      console.log("✅ Connection restored via ensureConnection");
    } catch (err) {
      console.log(`⚠️ ensureConnection: ${err?.message || "ping failed"}, triggering reconnect`);
      triggerReconnect();
      throw new Error("Service is busy right now. Please try again shortly.");
    }
  }
  return client;
}

// ============================================
// TELEGRAM REQUEST QUEUE (prevents queue buildup)
// ============================================
const telegramRequest = async (fn) => {
  await ensureConnection();

  return new Promise((resolve, reject) => {
    const execute = async () => {
      try {
        const result = await fn(client);
        resolve(result);
      } catch (error) {
        reject(error);
      }
    };

    if (TELEGRAM_LOCK.locked) {
      TELEGRAM_LOCK.queue.push(execute);
      if (TELEGRAM_LOCK.queue.length > 100) {
        TELEGRAM_LOCK.queue.shift();
      }
    } else {
      TELEGRAM_LOCK.locked = true;
      execute().finally(() => {
        processTelegramQueue();
      });
    }
  });
};

const processTelegramQueue = () => {
  const next = TELEGRAM_LOCK.queue.shift();
  if (next) {
    next().finally(() => {
      processTelegramQueue();
    });
  } else {
    TELEGRAM_LOCK.locked = false;
  }
};

// ============================================
// MUSIC SEARCH (with proper error handling)
// ============================================
const performMusicSearch = async (query) => {
  let completed = false;
  let timeout;
  let handler;
  let handlerAttached = false;
  const searchId = createId("search");

  const cleanup = () => {
    if (completed) return;
    completed = true;
    clearTimeout(timeout);
    if (handlerAttached && client) {
      try {
        client.removeEventHandler(handler);
      } catch {
        // Handler cleanup failed - non-critical
      }
      handlerAttached = false;
    }
    musicEventHandlers.delete(searchId);
  };

  const completeOnce = (fn) => {
    if (completed) return;
    cleanup();
    fn();
  };

  return new Promise((resolve, reject) => {
    handler = async (event) => {
      const msg = event.message;
      if (!msg?.senderId || !bot || msg.senderId.value !== bot.id.value) return;
      if (completed) return;

      try {
        if (msg.message && !msg.media) {
          const text = sanitizeLabel(msg.message || "");
          if (!text) return;
          if (text.includes("⏳")) return;

          const buttonOptions = flattenReplyButtons(msg);
          const textOptions = parseMusicOptionsFromText(msg.message || "");
          const rawOptions = buttonOptions.length > 0 ? buttonOptions : textOptions;
          const options = filterMusicOptions(rawOptions, query);

          if (options.length === 0) {
            const setupButtonFound = rawOptions.some((option) =>
              isSystemMusicButton(option?.label || "")
            );
            if (setupButtonFound) return;

            if (/not found|no results|error|invalid/i.test(text)) {
              completeOnce(() => reject(new HttpError(404, text)));
            }
            return;
          }

          const sessionId = createId("music");
          musicSearchSessions.set(sessionId, {
            messageId: msg.id,
            options,
            createdAt: Date.now(),
            query,
          });

          completeOnce(() => {
            resolve({
              sessionId,
              query,
              suggestions: serializeMusicOptions(options),
            });
          });
        }
      } catch (error) {
        completeOnce(() => {
          reject(new HttpError(500, error?.message || "Failed to read music suggestions"));
        });
      }
    };

    timeout = setTimeout(() => {
      completeOnce(() => reject(new HttpError(504, "Music search timed out. Please try again.")));
    }, CONFIG.MUSIC_SEARCH_TIMEOUT_MS);

    const startSearch = async () => {
      try {
        client.addEventHandler(handler, new NewMessage({}));
        handlerAttached = true;
        musicEventHandlers.set(searchId, { handler, searchId });

        await client.sendMessage(bot, { message: query });
      } catch (error) {
        completeOnce(() => reject(new HttpError(500, error?.message || "Unable to search music right now")));
      }
    };

    startSearch();
  });
};

// ============================================
// FILE DOWNLOAD HELPERS
// ============================================
const pushFileError = (id, message, platform = "media") => {
  progressMap.set(id, -1);
  files.set(id, { error: true, message: message || "Download failed", platform });

  setTimeout(() => {
    files.delete(id);
    progressMap.delete(id);
  }, 10000);
};

const downloadMediaFromMessage = async ({ message, id, platform = "media" }) => {
  let buffer;
  let fileType = "unknown";
  let fileExt = "bin";
  let total = 1;
  let mimeType = "";

  if (message?.media?.photo) {
    fileType = "image";
    fileExt = "jpg";
    mimeType = "image/jpeg";

    if (message.media.photo.sizes && message.media.photo.sizes.length > 0) {
      const sizes = message.media.photo.sizes;
      const largestSize = sizes[sizes.length - 1];
      total = largestSize?.bytes || 1;
    }

    buffer = await client.downloadMedia(message, {
      progressCallback: (received) => {
        const percent = Math.min(99, Math.floor((received / total) * 100));
        progressMap.set(id, percent);
      },
    });
  } else if (message?.media?.document) {
    const doc = message.media.document;
    total = doc.size || 1;
    mimeType = normalizeMime(doc.mimeType || "");

    if (mimeType.startsWith("image/")) fileType = "image";
    else if (mimeType.startsWith("video/")) fileType = "video";
    else if (mimeType.startsWith("audio/")) fileType = "audio";
    else fileType = "unknown";

    fileExt = deriveFileExtension(doc, mimeType);
    if (fileType === "video" && !["mp4", "mov", "webm", "mkv"].includes(fileExt)) {
      fileExt = "mp4";
    }

    buffer = await client.downloadMedia(message, {
      progressCallback: (received) => {
        const percent = Math.min(99, Math.floor((received / total) * 100));
        progressMap.set(id, percent);
      },
    });
  }

  if (!buffer || buffer.length === 0) {
    throw new Error("No media received from bot");
  }

  files.set(id, {
    buffer,
    type: fileType,
    ext: fileExt,
    mime: mimeType,
    platform,
    size: total,
  });

  progressMap.set(id, 100);
};

const attachSingleMediaHandler = ({ id, platform, onTextMessage, timeoutMs = CONFIG.MEDIA_DOWNLOAD_TIMEOUT_MS }) => {
  const createdAt = Date.now();
  pendingMessages.set(id, {
    waitingForMedia: true,
    mode: platform,
    requestAt: createdAt,
  });

  const timeout = setTimeout(() => {
    if (!pendingMessages.has(id)) return;
    pendingMessages.delete(id);
    if (client) {
      try { client.removeEventHandler(handler); } catch {}
    }
    pushFileError(id, "Download timed out. Please try again.", platform);
  }, timeoutMs);

  const cleanup = () => {
    clearTimeout(timeout);
    pendingMessages.delete(id);
    if (client) {
      try { client.removeEventHandler(handler); } catch {}
    }
  };

  const handler = async (event) => {
    const msg = event.message;
    if (!msg?.senderId || !bot || msg.senderId.value !== bot.id.value) return;
    if (!pendingMessages.has(id)) return;

    if (msg.message && !msg.media) {
      const text = sanitizeLabel(msg.message || "");
      if (!text) return;
      if (text.includes("⏳")) return;

      if (typeof onTextMessage === "function") {
        const shouldContinue = await onTextMessage(text, msg);
        if (shouldContinue) return;
      }

      cleanup();
      pushFileError(id, text, platform);
      return;
    }

    if (msg.media) {
      cleanup();
      try {
        await downloadMediaFromMessage({ message: msg, id, platform });
      } catch (error) {
        pushFileError(id, error?.message || "Failed to download media", platform);
      }
    }
  };

  client.addEventHandler(handler, new NewMessage({}));
  return cleanup;
};

// ============================================
// HEALTH ENDPOINT
// ============================================
app.get("/health", (req, res) => {
  res.json({
    status: ready ? "ok" : "degraded",
    uptime: process.uptime(),
    connections: {
      files: files.size,
      progress: progressMap.size,
      pendingMessages: pendingMessages.size,
      musicSessions: musicSearchSessions.size,
      inflightSearches: inFlightMusicSearches.size,
      queueLength: TELEGRAM_LOCK.queue.length,
    },
    memory: process.memoryUsage(),
  });
});

// ============================================
// API ENDPOINTS
// ============================================

app.post("/api/download", async (req, res) => {
  const { url } = req.body;

  if (!url) return res.status(400).json({ error: "URL is required" });
  if (!isValidUrl(url)) return res.status(400).json({ error: "Invalid URL format" });

  const platform = getPlatformFromUrl(url);
  if (!platform) return res.status(400).json({ error: "URL not supported" });

  if (files.size >= CONFIG.MAX_FILES) {
    return res.status(503).json({ error: "Server is at capacity. Please try again shortly." });
  }

  try {
    await ensureConnection();
  } catch {
    return res.status(503).json({ error: "The server is busy. Please try again in a few minutes." });
  }

  const id = createId("media");
  progressMap.set(id, 0);

  let detachMediaHandler = null;

  try {
    detachMediaHandler = attachSingleMediaHandler({ id, platform });
    await client.sendMessage(bot, { message: url.trim() });
    res.json({ id, platform });
  } catch (error) {
    if (detachMediaHandler) detachMediaHandler();
    pendingMessages.delete(id);
    progressMap.delete(id);
    res.status(500).json({ error: error?.message || "Failed to start download" });
  }
});

app.post("/api/music/search", async (req, res) => {
  const query = sanitizeLabel(req.body?.query || "");
  if (!query) {
    return res.status(400).json({ error: "Song name or singer name is required" });
  }

  if (inFlightMusicSearches.size >= CONFIG.MAX_INFLIGHT_SEARCHES) {
    return res.status(503).json({ error: "Too many music searches right now. Please try again shortly." });
  }

  try {
    await ensureConnection();
  } catch {
    return res.status(503).json({ error: "Service is busy right now. Please try again shortly." });
  }

  const searchKey = buildMusicSearchKey(req, query);

  let searchPromise = inFlightMusicSearches.get(searchKey);
  if (!searchPromise) {
    searchPromise = performMusicSearch(query);
    inFlightMusicSearches.set(searchKey, searchPromise);
    searchPromise.finally(() => {
      if (inFlightMusicSearches.get(searchKey) === searchPromise) {
        inFlightMusicSearches.delete(searchKey);
      }
    });
  }

  try {
    const payload = await searchPromise;
    res.json(payload);
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    res.status(status).json({ error: error?.message || "Unable to search music right now" });
  }
});

app.post("/api/music/download", async (req, res) => {
  const sessionId = sanitizeLabel(req.body?.sessionId || "");
  const optionId = sanitizeLabel(req.body?.optionId || "");

  if (!sessionId || !optionId) {
    return res.status(400).json({ error: "sessionId and optionId are required" });
  }

  const session = musicSearchSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Music search expired. Please search again." });
  }

  if (Date.now() - session.createdAt > CONFIG.MUSIC_SESSION_TTL_MS) {
    musicSearchSessions.delete(sessionId);
    return res.status(410).json({ error: "Music search expired. Please search again." });
  }

  const optionIndex = Number(optionId) - 1;
  if (Number.isNaN(optionIndex) || optionIndex < 0 || optionIndex >= session.options.length) {
    return res.status(400).json({ error: "Invalid song selection" });
  }

  if (files.size >= CONFIG.MAX_FILES) {
    return res.status(503).json({ error: "Server is at capacity. Please try again shortly." });
  }

  try {
    await ensureConnection();
  } catch {
    return res.status(503).json({ error: "Service is busy right now. Please try again shortly." });
  }

  const selectedOption = session.options[optionIndex];
  const id = createId("music_file");
  progressMap.set(id, 0);

  let detachMediaHandler = null;

  try {
    detachMediaHandler = attachSingleMediaHandler({
      id,
      platform: "Music",
      onTextMessage: (text) => {
        if (/error|failed|not found|unavailable|cannot/i.test(text)) return false;
        if (/choose|select|again|retry|option|wait|processing|downloading|preparing|please|fetching|working/i.test(text)) return true;
        return false;
      },
      timeoutMs: CONFIG.MUSIC_DOWNLOAD_TIMEOUT_MS,
    });

    const optionNumber = String(optionIndex + 1);
    await client.sendMessage(bot, { message: optionNumber });

    musicSearchSessions.delete(sessionId);
    res.json({ id, platform: "Music", selected: selectedOption.label });
  } catch (error) {
    if (detachMediaHandler) detachMediaHandler();
    pendingMessages.delete(id);
    progressMap.delete(id);
    res.status(500).json({ error: error?.message || "Failed to request selected song" });
  }
});

app.get("/api/file/:id", async (req, res) => {
  const fileData = files.get(req.params.id);

  if (!fileData || !fileData.buffer) {
    return res.status(404).json({ error: "File not found or expired" });
  }

  const timestamp = Date.now();
  const randomStr = Math.random().toString(36).substring(2, 8);
  const platform = fileData.platform || "media";
  let fileName;
  let contentType;

  if (fileData.type === "image") {
    fileName = `${platform}_${timestamp}_${randomStr}.${fileData.ext}`;
    switch (fileData.ext) {
      case "jpg": case "jpeg": contentType = "image/jpeg"; break;
      case "png": contentType = "image/png"; break;
      case "gif": contentType = "image/gif"; break;
      case "webp": contentType = "image/webp"; break;
      case "bmp": contentType = "image/bmp"; break;
      default: contentType = fileData.mime || "image/jpeg";
    }
  } else if (fileData.type === "video") {
    fileName = `${platform}_${timestamp}_${randomStr}.${fileData.ext || "mp4"}`;
    contentType = fileData.mime || "video/mp4";
  } else if (fileData.type === "audio") {
    fileName = `${platform}_${timestamp}_${randomStr}.${fileData.ext || "mp3"}`;
    contentType = fileData.mime || "audio/mpeg";
  } else {
    fileName = `${platform}_${timestamp}_${randomStr}.${fileData.ext}`;
    contentType = fileData.mime || "application/octet-stream";
  }

  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", fileData.buffer.length);
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  res.send(fileData.buffer);

  res.on("finish", () => {
    files.delete(req.params.id);
    progressMap.delete(req.params.id);
  });

  res.on("close", () => {
    if (!res.writableEnded) {
      files.delete(req.params.id);
      progressMap.delete(req.params.id);
    }
  });
});

app.get("/api/progress/:id", (req, res) => {
  const progress = progressMap.get(req.params.id);
  const fileData = files.get(req.params.id);

  if (progress === undefined) {
    return res.status(404).json({ error: "Progress not found" });
  }

  if (progress === -1 && fileData?.error) {
    return res.json({ progress: -1, error: fileData.message || "This video cannot be downloaded" });
  }

  res.json({ progress });
});

app.get("/api/info/:id", (req, res) => {
  const fileData = files.get(req.params.id);

  res.json({
    exists: !!(fileData && fileData.buffer),
    type: fileData?.type || null,
    ext: fileData?.ext || null,
    platform: fileData?.platform || null,
    error: fileData?.error || false,
    message: fileData?.message || null,
    size: fileData?.buffer?.length || 0,
  });
});

// ============================================
// SERVER START
// ============================================
connectTelegram();

const server = app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Server running on port ${CONFIG.PORT}`);
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
const gracefulShutdown = async (signal) => {
  console.log(`\n⚠️  Received ${signal}. Starting graceful shutdown...`);

  server.close(() => {
    console.log("✅ HTTP server closed");
  });

  const shutdownTimeout = setTimeout(() => {
    console.error("⚠️  Forced shutdown after timeout");
    process.exit(1);
  }, CONFIG.GRACEFUL_SHUTDOWN_TIMEOUT_MS);

  try {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (keepAliveTimer) clearInterval(keepAliveTimer);

    if (client) {
      try {
        await client.disconnect();
        console.log("✅ Telegram client disconnected");
      } catch {
        // non-critical
      }
    }

    files.destroy();

    clearTimeout(shutdownTimeout);
    console.log("✅ Graceful shutdown complete");
    process.exit(0);
  } catch {
    clearTimeout(shutdownTimeout);
    process.exit(1);
  }
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// ============================================
// ERROR HANDLING - NEVER CRASH THE PROCESS
// ============================================
process.on("uncaughtException", (err) => {
  console.error("💥 Fatal error:", err.message, err.stack);

  if (!ready && err.message.includes("ping")) {
    return;
  }

  if (err.message.includes("Timeout")) {
    console.log("🔄 Timeout error caught - resuming normal operation");
    return;
  }

  if (err.message.includes("disconnected") || err.message.includes("DISCONNECT")) {
    console.log("🔄 Telegram disconnected - initiating reconnection");
    ready = false;
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(connectTelegram, 5000);
    }
    return;
  }

  console.log("🔄 Uncaught exception swallowed - server continues running");
});

process.on("unhandledRejection", (reason) => {
  if (reason instanceof HttpError) {
    console.log(`⚠️ Unhandled HttpError: ${reason.status} - ${reason.message}`);
    return;
  }

  if (reason?.message && reason.message.includes("Timeout")) {
    console.log("⚠️ Unhandled timeout rejection swallowed");
    return;
  }

  if (reason?.message && reason.message.includes("disconnected")) {
    console.log("⚠️ Disconnection rejection ignored - reconnection will handle");
    return;
  }

  console.error("⚠️ Unhandled rejection:", reason?.message || reason);
});
