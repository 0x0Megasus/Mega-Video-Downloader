import express from "express";
import dotenv from "dotenv";
import dns from "dns";
import net from "net";
import fs from "fs/promises";
import { existsSync, createReadStream } from "fs";
import path from "path";
import os from "os";
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
  TELEGRAM_CONNECTION_RETRIES: 5,
  TELEGRAM_RETRY_DELAY: 2000,
  TELEGRAM_TIMEOUT: 15,
  TELEGRAM_DC: { id: 4, ip: "149.154.167.91", port: 443 },
  GRACEFUL_SHUTDOWN_TIMEOUT_MS: 10000,
};

const TEMP_DIR = path.join(os.tmpdir(), "downvid");

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
  #onDelete;

  constructor(maxSize = 1000, ttlMs = 10 * 60 * 1000, onDelete = null) {
    this.#maxSize = maxSize;
    this.#ttlMs = ttlMs;
    this.#onDelete = typeof onDelete === "function" ? onDelete : null;

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
    const entry = this.#map.get(key);
    if (entry) this.#onDelete?.(key, entry.value);
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
        this.#onDelete?.(key, entry.value);
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
    if (oldestKey) {
      const entry = this.#map.get(oldestKey);
      this.#map.delete(oldestKey);
      this.#onDelete?.(oldestKey, entry.value);
    }
  }

  destroy() {
    clearInterval(this.#cleanupInterval);
    for (const [, entry] of this.#map) {
      this.#onDelete?.(null, entry.value);
    }
    this.#map.clear();
  }
}

const deleteTempFile = (_key, value) => {
  if (value?.filePath) {
    fs.unlink(value.filePath).catch(() => {});
  }
};

const files = new BoundedMap(CONFIG.MAX_FILES, CONFIG.MAX_FILE_AGE_MS, deleteTempFile);
const progressMap = new BoundedMap(CONFIG.MAX_PROGRESS_ENTRIES, CONFIG.MAX_PROGRESS_AGE_MS);
const pendingMessages = new Map();
const musicSearchSessions = new BoundedMap(CONFIG.MAX_MUSIC_SESSIONS, CONFIG.MUSIC_SESSION_TTL_MS);
const inFlightMusicSearches = new Map();

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
    // Strip zero-width and invisible Unicode (ZWNJ, ZWJ, LRM, RLM, WJ, BOM,
    // Hangul filler, various invisible control chars and narrow no-break space)
    .replace(/[\u200B-\u200F\u2028\u2029\u202A-\u202F\u2060-\u2069\uFEFF\u00A0\u3164\u00AD]+/g, "")
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
  /^subscribe$/i, /^my subscriptions?$/i, /^check subscriptions?$/i,
  /^remove ads?$/i, /^\+?\s*remove ads?$/i,
  /^premium$/i, /^donate$/i, /^invite friends?$/i, /^share$/i,
  /^language$/i, /^my (account|profile)$/i, /^favorites$/i,
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
let reconnectionInProgress = false;

const TELEGRAM_DC = CONFIG.TELEGRAM_DC;

function triggerReconnect() {
  if (reconnectionInProgress || reconnectTimer) return;
  reconnectionInProgress = true;
  ready = false;
  console.log("🔄 Initiating reconnection...");
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  connectTelegram();
}

async function connectTelegram() {
  reconnectionInProgress = true;

  if (client) {
    try {
      await client.disconnect();
    } catch {
      // non-critical
    }
  }

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
        retryDelay: CONFIG.TELEGRAM_RETRY_DELAY,
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

    const isDuplicate = error.message.includes("AUTH_KEY_DUPLICATED");
    const baseDelay = isDuplicate ? 30000 : 5000;
    const delayRaw = Math.min(baseDelay * connectionAttempts, 60000);
    const jitter = 0.5 + Math.random(); // 0.5–1.5x jitter
    const delay = Math.round(delayRaw * jitter);
    if (isDuplicate) {
      console.log(`⚠️ Session in use elsewhere. Retrying in ${(delay / 1000).toFixed(1)} seconds...`);
    } else {
      console.log(`⏰ Retrying in ${(delay / 1000).toFixed(1)} seconds...`);
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectTelegram();
    }, delay);
  } finally {
    reconnectionInProgress = false;
  }
}

// Library's _updateLoop handles keep-alive internally via PingDelayDisconnect

async function ensureConnection() {
  if (!client) {
    triggerReconnect();
    throw new Error("Service is busy right now. Please try again shortly.");
  }
  if (!ready) {
    if (client.connected) {
      ready = true;
      return client;
    }
    triggerReconnect();
    throw new Error("Service is busy right now. Please try again shortly.");
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
const parseBotResponse = (msg, query) => {
  const buttonOptions = flattenReplyButtons(msg);
  const textOptions = parseMusicOptionsFromText(msg.message || "");
  const rawOptions = buttonOptions.length > 0
    ? [...buttonOptions, ...textOptions]
    : textOptions;
  const options = filterMusicOptions(rawOptions, query);
  return { rawOptions, options };
};

const performMusicSearch = async (query) => {
  const sentMsg = await client.sendMessage(bot, { message: query });
  const afterDate = sentMsg.date;

  const deadline = Date.now() + CONFIG.MUSIC_SEARCH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let result;
    try {
      const inputPeer = await client.getInputEntity(bot);
      result = await client.invoke(new Api.messages.GetHistory({
        peer: inputPeer,
        limit: 10,
        offsetId: 0,
        offsetDate: 0,
        addOffset: 0,
        maxId: 0,
        minId: 0,
        hash: BigInt(0),
      }));
    } catch (e) {
      console.error("[poll] getHistory failed:", e?.message);
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }

    const msgs = result.messages || [];
    if (msgs.length === 0) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }

    const candidates = msgs.filter(
      (m) => m.date > afterDate && m.senderId?.value === bot.id.value
    );

    if (candidates.length === 0) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }

    for (const msg of candidates) {
      const text = sanitizeLabel(msg.message || "");
      if (!text || text.includes("⏳")) continue;

      const { rawOptions, options } = parseBotResponse(msg, query);

      if (options.length > 0) {
        const sessionId = createId("music");
        musicSearchSessions.set(sessionId, {
          messageId: msg.id,
          options,
          createdAt: Date.now(),
          query,
        });
        return { sessionId, query, suggestions: serializeMusicOptions(options) };
      }

      if (/not found|no results|error|invalid/i.test(text)) {
        throw new HttpError(404, text);
      }
    }

    await new Promise((r) => setTimeout(r, 1500));
  }

  throw new HttpError(504, "Music search timed out. Please try again.");
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

  // Write to temp file instead of holding buffer in memory
  await fs.mkdir(TEMP_DIR, { recursive: true });
  const filePath = path.join(TEMP_DIR, id);
  await fs.writeFile(filePath, buffer);

  // Free the buffer — only store metadata
  files.set(id, {
    filePath,
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
      if (!text || !/[\p{L}\p{N}]/u.test(text)) return;
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
    }).catch(() => {});
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

    if (selectedOption.action.type === "callback") {
      try {
        await client.invoke(
          new Api.messages.GetBotCallbackAnswer({
            peer: bot,
            msgId: session.messageId,
            data: selectedOption.action.data,
          })
        );
      } catch (callbackError) {
        // BOT_RESPONSE_TIMEOUT means the bot didn't acknowledge the callback
        // within Telegram's deadline — it's still processing the download and
        // will likely send media which attachSingleMediaHandler will catch.
        console.log(`⚠️ Music download callback warning: ${callbackError?.message || callbackError}`);
      }
    } else {
      await client.sendMessage(bot, { message: selectedOption.action.text });
    }

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

  if (!fileData || !fileData.filePath) {
    return res.status(404).json({ error: "File not found or expired" });
  }

  if (!existsSync(fileData.filePath)) {
    files.delete(req.params.id);
    progressMap.delete(req.params.id);
    return res.status(404).json({ error: "File not found on disk" });
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
  res.setHeader("Content-Length", fileData.size);
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  const readStream = createReadStream(fileData.filePath);
  readStream.pipe(res);

  readStream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to read file" });
    }
    files.delete(req.params.id);
    progressMap.delete(req.params.id);
  });

  res.on("finish", () => {
    files.delete(req.params.id);
    progressMap.delete(req.params.id);
  });

  res.on("close", () => {
    if (!res.writableEnded) {
      readStream.destroy();
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
    exists: !!(fileData && fileData.filePath),
    type: fileData?.type || null,
    ext: fileData?.ext || null,
    platform: fileData?.platform || null,
    error: fileData?.error || false,
    message: fileData?.message || null,
    size: fileData?.size || 0,
  });
});

// ============================================
// SERVER START
// ============================================
const FIRST_CONNECT_BASE_MS = parseInt(process.env.FIRST_CONNECT_DELAY || "20000", 10);
const FIRST_CONNECT_JITTER_MS = Math.round(Math.random() * FIRST_CONNECT_BASE_MS);
const firstConnectDelay = FIRST_CONNECT_BASE_MS + FIRST_CONNECT_JITTER_MS;
setTimeout(() => {
  if (!client && !reconnectTimer && !reconnectionInProgress) connectTelegram();
}, firstConnectDelay);

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
