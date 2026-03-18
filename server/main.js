import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import cors from "cors";
import dns from "dns";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { Api } from "telegram/tl/index.js";

// Force IPv4 and use reliable DNS
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '1.1.1.1']);

dotenv.config();

// GLOBALS
const API_ID = Number(process.env.API_ID?.trim());
const API_HASH = process.env.API_HASH?.trim();
const SESSION = process.env.SESSION?.trim();
const BOT_USERNAME = process.env.BOT_USERNAME?.trim();

console.log("=== SERVER STARTING ===");
console.log("API_ID:", API_ID);
console.log("API_HASH length:", API_HASH?.length);
console.log("SESSION length:", SESSION?.length);
console.log("BOT_USERNAME:", BOT_USERNAME);
console.log("======================");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.CLIENT_URL }));

const PORT = process.env.PORT || 5000;

// State
const progressMap = new Map();
const files = new Map();

// Platform validation patterns (keep as is)
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
      /^(https?:\/\/)?(vm\.tiktok\.com)\/[\w-]+/
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

// Telegram DC4 ONLY
const TELEGRAM_DC4 = {
  ip: "149.154.167.91",
  port: 443
};

let client;
let bot;
let ready = false;
let reconnectTimer = null;
let connectionCheckTimer = null;

async function ensureConnection() {
  if (!client || !ready) {
    throw new Error("Telegram not connected");
  }
  return client;
}

async function connectTelegram() {
  try {
    // Clear any existing timers
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (connectionCheckTimer) {
      clearInterval(connectionCheckTimer);
      connectionCheckTimer = null;
    }

    console.log("Connecting to Telegram DC4...");
    
    if (!API_ID || !API_HASH || !SESSION) {
      throw new Error("Missing required environment variables");
    }

    // Create client with DC4 settings
    client = new TelegramClient(
      new StringSession(SESSION),
      API_ID,
      API_HASH,
      {
        connectionRetries: 2,
        useWSS: false,
        baseDc: 4,
        ipVersion: 4,
        deviceModel: "Railway Server",
        systemVersion: "Linux",
        appVersion: "1.0.0",
        langCode: "en",
        timeout: 15,
        autoReconnect: false, // We'll handle reconnection manually
      }
    );

    // Force DC4
    client.session.setDC(4, TELEGRAM_DC4.ip, TELEGRAM_DC4.port);
    
    console.log(`Connecting to ${TELEGRAM_DC4.ip}:${TELEGRAM_DC4.port}`);

    // Connect
    await client.connect();

    // Check authorization
    if (!(await client.isUserAuthorized())) {
      throw new Error("Session expired");
    }

    // Get bot entity
    bot = await client.getEntity(BOT_USERNAME);
    
    ready = true;
    console.log("✅ Telegram connected on DC4");

    // Simple ping every 60 seconds
    connectionCheckTimer = setInterval(async () => {
      if (client && ready) {
        try {
          await client.invoke(new Api.ping.Ping({ ping_id: BigInt(Date.now()) }));
        } catch (error) {
          console.log("Connection lost, reconnecting...");
          ready = false;
          clearInterval(connectionCheckTimer);
          reconnectTelegram();
        }
      }
    }, 60000);

  } catch (error) {
    console.error("❌ DC4 connection failed:", error.message);
    
    if (error.message.includes('AUTH_KEY_DUPLICATED')) {
      console.log("⚠️ Session is being used elsewhere. Waiting 60 seconds...");
      setTimeout(connectTelegram, 60000);
    } else {
      // Simple retry after 10 seconds
      setTimeout(connectTelegram, 10000);
    }
  }
}

function reconnectTelegram() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectTelegram, 5000);
}

// Start connection
connectTelegram();

// API Endpoints
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

  if (!ready) {
    return res.status(503).json({ error: "Telegram connecting, please wait..." });
  }

  console.log(`Processing ${platform}: ${url}`);
  const id = Date.now().toString();
  
  progressMap.set(id, 0);

  try {
    await client.sendMessage(bot, { message: url });

    const handler = async (event) => {
      const msg = event.message;
      if (!msg.senderId || msg.senderId.value !== bot.id.value) return;

      if (msg.media?.document || msg.media?.photo) {
        try {
          let buffer;
          let fileExt = "mp4";
          let fileType = "video";
          
          let total = 1;
          if (msg.media?.document) {
            total = msg.media.document.size || 1;
          } else if (msg.media?.photo) {
            total = msg.media.photo.sizes?.pop()?.bytes || 1;
            fileExt = "jpg";
            fileType = "image";
          }

          buffer = await client.downloadMedia(msg, {
            progressCallback: (received) => {
              const percent = Math.floor((received / total) * 100);
              progressMap.set(id, percent);
            },
          });

          const dir = path.join(__dirname, "temp");
          if (!fs.existsSync(dir)) fs.mkdirSync(dir);

          const filePath = path.join(dir, `content_${id}.${fileExt}`);
          fs.writeFileSync(filePath, buffer);

          files.set(id, { path: filePath, type: fileType });
          progressMap.set(id, 100);

        } catch (error) {
          console.error(`Download failed:`, error);
          progressMap.set(id, -1);
        }
        client.removeEventHandler(handler);
      }
    };

    client.addEventHandler(handler, new NewMessage({}));
    res.json({ id, platform });

  } catch (error) {
    console.error("Download error:", error);
    progressMap.delete(id);
    res.status(500).json({ error: "Download failed" });
  }
});

app.get("/api/progress/:id", (req, res) => {
  const progress = progressMap.get(req.params.id);
  if (progress === undefined) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json({ progress });
});

app.get("/api/file/:id", (req, res) => {
  const fileData = files.get(req.params.id);
  if (!fileData || !fs.existsSync(fileData.path)) {
    return res.status(404).json({ error: "File not found" });
  }

  const fileName = fileData.type === "image" ? "image.jpg" : "video.mp4";
  res.download(fileData.path, fileName, () => {
    fs.unlinkSync(fileData.path);
    files.delete(req.params.id);
    progressMap.delete(req.params.id);
  });
});

app.get("/api/info/:id", (req, res) => {
  const fileData = files.get(req.params.id);
  res.json({ 
    exists: !!fileData && fs.existsSync(fileData.path),
    type: fileData?.type || null
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Error handling
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
  if (err.message.includes('AUTH_KEY_DUPLICATED')) {
    console.log('Session conflict, waiting before reconnect...');
    setTimeout(connectTelegram, 30000);
  }
});