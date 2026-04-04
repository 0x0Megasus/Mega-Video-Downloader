import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import cors from "cors";
import dns from "dns";
import net from "net";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { Api } from "telegram/tl/index.js";

// Force IPv4 only - CRITICAL FIX
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '1.1.1.1']);

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const allowedOrigins = (process.env.CLIENT_URL || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser clients and all origins when no allowlist is configured.
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    }
  })
);

const PORT = process.env.PORT || 5000;

// State
const progressMap = new Map(); // id -> progress
const files = new Map(); // id -> { buffer, type, ext, mime, platform, error, message }
const pendingMessages = new Map(); // id -> { waitingForMedia: true, mode, requestAt }
const musicSearchSessions = new Map(); // sessionId -> { messageId, options, createdAt, query }

const MUSIC_SESSION_TTL_MS = 5 * 60 * 1000;

// Platform validation patterns - WITH vt.tiktok.com SUPPORT
const platformValidators = [
  { 
    name: "YouTube",
    patterns: [
      /^(https?:\/\/)?(www\.)?youtube\.com\/watch\?v=[\w-]+/,
      /^(https?:\/\/)?(www\.)?youtube\.com\/shorts\/[\w-]+/,
      /^(https?:\/\/)?(www\.)?youtu\.be\/[\w-]+/
    ]
  },
  { 
    name: "TikTok",
    patterns: [
      /^(https?:\/\/)?(www\.)?tiktok\.com\/@[\w.-]+\/video\/\d+/,
      /^(https?:\/\/)?(www\.)?tiktok\.com\/[\w-]+/,
      /^(https?:\/\/)?(vm\.tiktok\.com)\/[\w-]+/,
      /^(https?:\/\/)?(vt\.tiktok\.com)\/[\w-]+/
    ]
  },
  { 
    name: "Instagram",
    patterns: [
      /^(https?:\/\/)?(www\.)?instagram\.com\/(p|reel|tv)\/[\w-]+/,
      /^(https?:\/\/)?(www\.)?instagram\.com\/[\w-]+\/?/
    ]
  },
  { 
    name: "Facebook",
    patterns: [
      /^(https?:\/\/)?(www\.)?facebook\.com\/.*\/videos\/\d+/,
      /^(https?:\/\/)?(www\.)?facebook\.com\/watch\/?\?v=\d+/,
      /^(https?:\/\/)?(www\.)?fb\.watch\/[\w-]+/
    ]
  },
  { 
    name: "Pinterest",
    patterns: [
      /^(https?:\/\/)?(www\.)?pin\.it\/[\w-]+/,
      /^(https?:\/\/)?(www\.)?pinterest\.[a-z.]{2,}\/pin\/[\w-]+/,
      /^(https?:\/\/)?(www\.)?pinterest\.[a-z.]{2,}\/[\w-]+\/[\w-]+\/\d+/,
      /^(https?:\/\/)?(www\.)?pinterest\.[a-z.]{2,}\/[\w-]+\/[\w-]+$/,
      /^(https?:\/\/)?(www\.)?pinterest\.[a-z.]{2,}\/pin\/\d+/,
      /^(https?:\/\/)?(www\.)?pinterest\.[a-z.]{2,}\/[\w-]+\/\d+$/
    ]
  },
  { 
    name: "Twitter/X",
    patterns: [
      /^(https?:\/\/)?(www\.)?twitter\.com\/\w+\/status\/\d+/,
      /^(https?:\/\/)?(www\.)?x\.com\/\w+\/status\/\d+/
    ]
  },
  { 
    name: "Reddit",
    patterns: [
      /^(https?:\/\/)?(www\.)?reddit\.com\/r\/\w+\/comments\/\w+\/[\w-]+/
    ]
  },
  { 
    name: "Vimeo",
    patterns: [
      /^(https?:\/\/)?(www\.)?vimeo\.com\/\d+/
    ]
  },
  { 
    name: "Dailymotion",
    patterns: [
      /^(https?:\/\/)?(www\.)?dailymotion\.com\/video\/[\w-]+/
    ]
  }
];

const isValidUrl = (string) => {
  try {
    new URL(string);
    return true;
  } catch {
    return false;
  }
};

const getPlatformFromUrl = (url) => {
  for (const platform of platformValidators) {
    for (const pattern of platform.patterns) {
      if (pattern.test(url)) {
        return platform.name;
      }
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

const flattenReplyButtons = (msg) => {
  const rows = msg?.replyMarkup?.rows || [];
  const options = [];

  for (const row of rows) {
    const buttons = row?.buttons || [];
    for (const button of buttons) {
      const text = sanitizeLabel(button?.text || "");
      if (!text) continue;

      if (button?.data !== undefined && button?.data !== null) {
        options.push({
          label: text,
          action: {
            type: "callback",
            data: button.data
          }
        });
      } else {
        options.push({
          label: text,
          action: {
            type: "text",
            text
          }
        });
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
      options.push({
        label: numberedMatch[2].trim(),
        action: {
          type: "text",
          text: numberedMatch[1]
        }
      });
    }
  }

  return options;
};

const serializeMusicOptions = (options = []) => {
  return options.map((option, index) => ({
    id: String(index + 1),
    label: option.label
  }));
};

const scheduleMusicSessionCleanup = (sessionId) => {
  setTimeout(() => {
    musicSearchSessions.delete(sessionId);
  }, MUSIC_SESSION_TTL_MS);
};

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of musicSearchSessions.entries()) {
    if (now - session.createdAt > MUSIC_SESSION_TTL_MS) {
      musicSearchSessions.delete(sessionId);
    }
  }
}, 60000);

const pushFileError = (id, message, platform = "media") => {
  progressMap.set(id, -1);
  files.set(id, {
    error: true,
    message: message || "Download failed",
    platform
  });

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
      }
    });
  } else if (message?.media?.document) {
    const doc = message.media.document;
    total = doc.size || 1;
    mimeType = normalizeMime(doc.mimeType || "");

    if (mimeType.startsWith("image/")) {
      fileType = "image";
    } else if (mimeType.startsWith("video/")) {
      fileType = "video";
    } else if (mimeType.startsWith("audio/")) {
      fileType = "audio";
    } else {
      fileType = "unknown";
    }

    fileExt = deriveFileExtension(doc, mimeType);
    if (fileType === "video" && !["mp4", "mov", "webm", "mkv"].includes(fileExt)) {
      fileExt = "mp4";
    }

    buffer = await client.downloadMedia(message, {
      progressCallback: (received) => {
        const percent = Math.min(99, Math.floor((received / total) * 100));
        progressMap.set(id, percent);
      }
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
    size: total
  });

  progressMap.set(id, 100);
};

const attachSingleMediaHandler = ({ id, platform, onTextMessage, timeoutMs = 120000 }) => {
  const createdAt = Date.now();
  pendingMessages.set(id, {
    waitingForMedia: true,
    mode: platform,
    requestAt: createdAt
  });

  const timeout = setTimeout(() => {
    if (!pendingMessages.has(id)) return;
    pendingMessages.delete(id);
    client.removeEventHandler(handler);
    pushFileError(id, "Download timed out. Please try again.", platform);
  }, timeoutMs);

  const cleanup = () => {
    clearTimeout(timeout);
    pendingMessages.delete(id);
    client.removeEventHandler(handler);
  };

  const handler = async (event) => {
    const msg = event.message;
    if (!msg?.senderId || msg.senderId.value !== bot.id.value) return;
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
// TELEGRAM CONNECTION
// ============================================

// Hardcoded DC4 - confirmed working
const TELEGRAM_DC = {
  id: 4,
  ip: "149.154.167.91",
  port: 443
};

let client;
let bot;
let ready = false;
let connectionAttempts = 0;

async function connectTelegram() {
  try {
    connectionAttempts++;
    console.log(`🔌 Connecting to Telegram DC${TELEGRAM_DC.id} (attempt ${connectionAttempts})...`);
    
    // Test TCP connection first
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
      
      socket.on('error', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(false);
      });
    });
    
    if (!connectionTest) {
      throw new Error(`Cannot reach ${TELEGRAM_DC.ip}:${TELEGRAM_DC.port}`);
    }
    
    console.log("✅ Network connection successful");
    
    // Create Telegram client
    client = new TelegramClient(
      new StringSession(process.env.SESSION || ""),
      Number(process.env.API_ID),
      process.env.API_HASH,
      {
        connectionRetries: 2,
        useWSS: false,
        baseDc: TELEGRAM_DC.id,
        ipVersion: 4,
        timeout: 15,
      }
    );
    
    // CRITICAL: Manually set the DC to bypass DNS
    client.session.setDC(TELEGRAM_DC.id, TELEGRAM_DC.ip, TELEGRAM_DC.port);
    
    // Connect
    await client.connect();
    
    // Verify authorization
    if (!(await client.isUserAuthorized())) {
      throw new Error("Session expired - need new login");
    }
    
    // Get bot
    bot = await client.getEntity(process.env.BOT_USERNAME);
    
    ready = true;
    connectionAttempts = 0;
    console.log("✅ Telegram ready and connected!");
    
  } catch (error) {
    console.error("❌ Connection error:", error.message);
    ready = false;
    
    // Simple retry with backoff
    const delay = Math.min(5000 * connectionAttempts, 30000);
    console.log(`⏰ Retrying in ${delay/1000} seconds...`);
    setTimeout(connectTelegram, delay);
  }
}

// Start connection
connectTelegram();

// ============================================
// KEEP-ALIVE
// ============================================

setInterval(async () => {
  if (client) {
    try {
      await client.invoke(new Api.ping.Ping({ 
        ping_id: BigInt(Date.now()) 
      }));
      console.log("💓 Keep-alive OK");
      
      if (!ready) {
        console.log("✅ Connection restored, marking as ready");
        ready = true;
      }
    } catch (err) {
      console.log("💓 Keep-alive failed (temporary)");
    }
  }
}, 45000);

async function ensureConnection() {
  if (!client) {
    throw new Error("Telegram client not initialized");
  }
  
  if (!ready) {
    try {
      await client.invoke(new Api.ping.Ping({ ping_id: BigInt(Date.now()) }));
      console.log("✅ Connection verified, marking as ready");
      ready = true;
    } catch (err) {
      throw new Error("Telegram not connected");
    }
  }
  
  return client;
}

// ============================================
// API ENDPOINTS - FIXED FOR ⏳ HANDLING
// ============================================

// Start download for media URLs (video/image)
app.post("/api/download", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: "Invalid URL format" });
  }

  const platform = getPlatformFromUrl(url);
  if (!platform) {
    return res.status(400).json({ error: "URL not supported" });
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

// Search music by song/singer name and return selectable suggestions
app.post("/api/music/search", async (req, res) => {
  const query = sanitizeLabel(req.body?.query || "");
  if (!query) {
    return res.status(400).json({ error: "Song name or singer name is required" });
  }

  try {
    await ensureConnection();
  } catch {
    return res.status(503).json({ error: "Telegram is busy right now. Please try again shortly." });
  }

  let completed = false;
  let timeout;

  const completeOnce = (fn) => {
    if (completed) return;
    completed = true;
    clearTimeout(timeout);
    fn();
  };

  const handler = async (event) => {
    const msg = event.message;
    if (!msg?.senderId || msg.senderId.value !== bot.id.value) return;
    if (completed) return;

    try {
      if (msg.message && !msg.media) {
        const text = sanitizeLabel(msg.message || "");
        if (!text) return;
        if (text.includes("⏳")) return;

        const buttonOptions = flattenReplyButtons(msg);
        const textOptions = parseMusicOptionsFromText(msg.message || "");
        const options = buttonOptions.length > 0 ? buttonOptions : textOptions;

        if (options.length === 0) {
          if (/not found|no results|error|invalid/i.test(text)) {
            completeOnce(() => {
              client.removeEventHandler(handler);
              res.status(404).json({ error: text });
            });
          }
          return;
        }

        const sessionId = createId("music");
        musicSearchSessions.set(sessionId, {
          messageId: msg.id,
          options,
          createdAt: Date.now(),
          query
        });
        scheduleMusicSessionCleanup(sessionId);

        completeOnce(() => {
          client.removeEventHandler(handler);
          res.json({
            sessionId,
            query,
            suggestions: serializeMusicOptions(options)
          });
        });
      }
    } catch (error) {
      completeOnce(() => {
        client.removeEventHandler(handler);
        res.status(500).json({ error: error?.message || "Failed to read music suggestions" });
      });
    }
  };

  timeout = setTimeout(() => {
    completeOnce(() => {
      client.removeEventHandler(handler);
      res.status(504).json({ error: "Music search timed out. Please try again." });
    });
  }, 45000);

  try {
    client.addEventHandler(handler, new NewMessage({}));
    await client.sendMessage(bot, { message: query });
  } catch (error) {
    clearTimeout(timeout);
    client.removeEventHandler(handler);
    res.status(500).json({ error: error?.message || "Unable to search music right now" });
  }
});

// Download selected song from the previous suggestion list
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

  if (Date.now() - session.createdAt > MUSIC_SESSION_TTL_MS) {
    musicSearchSessions.delete(sessionId);
    return res.status(410).json({ error: "Music search expired. Please search again." });
  }

  const optionIndex = Number(optionId) - 1;
  if (Number.isNaN(optionIndex) || optionIndex < 0 || optionIndex >= session.options.length) {
    return res.status(400).json({ error: "Invalid song selection" });
  }

  try {
    await ensureConnection();
  } catch {
    return res.status(503).json({ error: "Telegram is busy right now. Please try again shortly." });
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
        if (/error|failed|not found|unavailable|cannot/i.test(text)) {
          return false;
        }
        if (/choose|select|again|retry|option|wait|processing|downloading|preparing|please|fetching|working/i.test(text)) {
          return true;
        }
        return false;
      },
      timeoutMs: 150000
    });

    if (selectedOption.action.type === "callback") {
      await client.invoke(
        new Api.messages.GetBotCallbackAnswer({
          peer: bot,
          msgId: session.messageId,
          data: selectedOption.action.data
        })
      );
    } else {
      await client.sendMessage(bot, { message: selectedOption.action.text });
    }

    musicSearchSessions.delete(sessionId);
    res.json({
      id,
      platform: "Music",
      selected: selectedOption.label
    });
  } catch (error) {
    if (detachMediaHandler) detachMediaHandler();
    pendingMessages.delete(id);
    progressMap.delete(id);
    res.status(500).json({ error: error?.message || "Failed to request selected song" });
  }
});

// Download file endpoint - WITH UNIQUE FILENAMES AND PROPER CLEANUP
app.get("/api/file/:id", async (req, res) => {
  const fileData = files.get(req.params.id);

  if (!fileData || !fileData.buffer) {
    return res.status(404).json({ error: "File not found or expired" });
  }

  // Create a unique filename with platform, timestamp, and random string
  const timestamp = Date.now();
  const randomStr = Math.random().toString(36).substring(2, 8);
  const platform = fileData.platform || "media";
  let fileName;
  let contentType;
  
  if (fileData.type === "image") {
    // Format: platform_timestamp_random.image
    fileName = `${platform}_${timestamp}_${randomStr}.${fileData.ext}`;
    
    // Set correct content type based on extension
    switch(fileData.ext) {
      case 'jpg':
      case 'jpeg':
        contentType = 'image/jpeg';
        break;
      case 'png':
        contentType = 'image/png';
        break;
      case 'gif':
        contentType = 'image/gif';
        break;
      case 'webp':
        contentType = 'image/webp';
        break;
      case 'bmp':
        contentType = 'image/bmp';
        break;
      default:
        contentType = fileData.mime || 'image/jpeg';
    }
  } else if (fileData.type === "video") {
    // Format: platform_timestamp_random.mp4
    fileName = `${platform}_${timestamp}_${randomStr}.${fileData.ext || "mp4"}`;
    contentType = fileData.mime || "video/mp4";
  } else if (fileData.type === "audio") {
    fileName = `${platform}_${timestamp}_${randomStr}.${fileData.ext || "mp3"}`;
    contentType = fileData.mime || "audio/mpeg";
  } else {
    fileName = `${platform}_${timestamp}_${randomStr}.${fileData.ext}`;
    contentType = fileData.mime || 'application/octet-stream';
  }
  
  // Set headers for download with unique filename and no caching
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', fileData.buffer.length);
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
  // Send the buffer
  res.send(fileData.buffer);
  
  // ✅ PROPER CLEANUP: Wait for finish event before deleting
  res.on('finish', () => {
    // File successfully sent to client - NOW it's safe to delete
    files.delete(req.params.id);
    progressMap.delete(req.params.id);
    console.log(`✅ File sent and cleaned up: ${req.params.id} (${fileData.type})`);
  });
  
  // ✅ Handle client disconnection
  res.on('close', () => {
    if (!res.writableEnded) {
      // Client disconnected before download completed
      files.delete(req.params.id);
      progressMap.delete(req.params.id);
      console.log(`⚠️ Client disconnected, cleaned up: ${req.params.id}`);
    }
  });
});

// Get progress - WITH ERROR MESSAGE SUPPORT
app.get("/api/progress/:id", (req, res) => {
  const progress = progressMap.get(req.params.id);
  const fileData = files.get(req.params.id);
  
  if (progress === undefined) {
    return res.status(404).json({ error: "Progress not found" });
  }
  
  // If it's an error, send error message
  if (progress === -1 && fileData?.error) {
    return res.json({ 
      progress: -1, 
      error: fileData.message || "This video cannot be downloaded"
    });
  }
  
  res.json({ progress });
});

// Get file info - WITH ERROR INFO
app.get("/api/info/:id", (req, res) => {
  const fileData = files.get(req.params.id);
  
  res.json({ 
    exists: !!(fileData && fileData.buffer),
    type: fileData?.type || null,
    ext: fileData?.ext || null,
    platform: fileData?.platform || null,
    error: fileData?.error || false,
    message: fileData?.message || null,
    size: fileData?.buffer?.length || 0
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Debug - log ready state periodically
setInterval(() => {
  let totalMB = 0;
  for (const [_, fileData] of files) {
    if (fileData && fileData.buffer) {
      totalMB += fileData.buffer.length / (1024 * 1024);
    }
  }
  console.log(`📊 Status - Ready: ${ready}, Client: ${!!client}, Files: ${files.size}, MusicSessions: ${musicSearchSessions.size}, Total: ${totalMB.toFixed(2)} MB`);
}, 30000);

// Handle errors gracefully
process.on('uncaughtException', (err) => {
  console.error('💥 Fatal error:', err.message);
  // Don't exit on keep-alive errors
  if (!err.message.includes('ping') && !err.message.includes('Ping')) {
    process.exit(1);
  }
});
