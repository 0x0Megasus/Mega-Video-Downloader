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
import { Api } from "telegram/tl/index.js"; // Add this for ping

// Force IPv4 and use reliable DNS
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '1.1.1.1']); // Google & Cloudflare DNS

dotenv.config();

// Debug environment variables
console.log("=== RAW ENVIRONMENT VARIABLES ===");
console.log("API_ID:", JSON.stringify(process.env.API_ID));
console.log("API_HASH:", JSON.stringify(process.env.API_HASH));
console.log("SESSION length:", process.env.SESSION?.length);
console.log("SESSION first 50 chars:", process.env.SESSION?.substring(0, 50));
console.log("BOT_USERNAME:", JSON.stringify(process.env.BOT_USERNAME));
console.log("=================================");

// GLOBALS - Make these available everywhere
const API_ID = Number(process.env.API_ID?.trim());
const API_HASH = process.env.API_HASH?.trim();
const SESSION = process.env.SESSION?.trim();
const BOT_USERNAME = process.env.BOT_USERNAME?.trim();

console.log("=== CLEANED VARIABLES ===");
console.log("API_ID (number):", API_ID);
console.log("API_HASH length:", API_HASH?.length);
console.log("SESSION length:", SESSION?.length);
console.log("BOT_USERNAME:", BOT_USERNAME);
console.log("=========================");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.CLIENT_URL }));

const PORT = process.env.PORT || 5000;

// State
const progressMap = new Map(); // id -> progress
const files = new Map(); // id -> { path, type }

// Platform validation patterns
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

// Validate URL format
const isValidUrl = (string) => {
  try {
    new URL(string);
    return true;
  } catch {
    return false;
  }
};

// Check if URL is from a supported platform
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

// Telegram DC addresses (hardcoded to avoid DNS issues)
const TELEGRAM_SERVERS = {
  1: { ip: "149.154.175.53", port: 443 },
  2: { ip: "149.154.167.51", port: 443 },
  3: { ip: "149.154.175.100", port: 443 },
  4: { ip: "149.154.167.91", port: 443 },
  5: { ip: "91.108.56.130", port: 443 }
};

let client;
let bot;
let ready = false;
let currentDc = 2;
let reconnectTimer = null;
let connectionCheckTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

async function ensureConnection() {
  if (!client || !ready) {
    console.log("Waiting for Telegram connection...");
    for (let i = 0; i < 30; i++) {
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!ready) throw new Error("Telegram not connected");
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

    console.log(`Attempting to connect to Telegram DC${currentDc}...`);
    
    if (!API_ID || !API_HASH || !SESSION) {
      console.error("Missing required variables:", { 
        API_ID: !!API_ID, 
        API_HASH: !!API_HASH, 
        SESSION: !!SESSION,
        BOT_USERNAME: !!BOT_USERNAME
      });
      throw new Error("Missing required environment variables");
    }

    // Create client with forced connection settings
    client = new TelegramClient(
      new StringSession(SESSION),
      API_ID,
      API_HASH,
      {
        connectionRetries: 3,
        useWSS: false,
        baseDc: currentDc,
        ipVersion: 4,
        deviceModel: "Railway Server",
        systemVersion: "Linux",
        appVersion: "1.0.0",
        langCode: "en",
        timeout: 30,
        autoReconnect: true,
        floodSleepThreshold: 60,
        retryDelay: 2000,
        maxRetries: 5,
      }
    );

    // Manually set the DC connection
    const server = TELEGRAM_SERVERS[currentDc];
    client.session.setDC(currentDc, server.ip, server.port);
    
    console.log(`Connecting to DC${currentDc} at ${server.ip}:${server.port}`);

    // Connect with timeout
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Connection timeout")), 30000)
      )
    ]);

    // Check authorization
    if (!(await client.isUserAuthorized())) {
      throw new Error("Session expired or invalid");
    }

    // Get bot entity
    bot = await client.getEntity(BOT_USERNAME);
    
    ready = true;
    reconnectAttempts = 0;
    console.log(`✅ Telegram connected successfully on DC${currentDc}`);

    // Set up disconnect handler
    client.addEventHandler((update) => {
      if (update.className === 'UpdateUserStatus') {
        console.log("Connection status changed");
      }
    });

    // Monitor connection health with ping every 30 seconds
    connectionCheckTimer = setInterval(async () => {
      if (client && ready) {
        try {
          // Send a ping to keep connection alive
          await client.invoke(new Api.ping.Ping({ ping_id: BigInt(Date.now()) }));
          console.log("Heartbeat OK");
        } catch (error) {
          console.log("Heartbeat failed, connection may be dead:", error.message);
          ready = false;
          clearInterval(connectionCheckTimer);
          reconnectTelegram();
        }
      }
    }, 30000);

    // Handle disconnection
    client.addEventHandler((update) => {
      if (update.className === 'UpdateUserStatus') {
        console.log("Connection status changed");
      }
    });

    client.on('disconnect', () => {
      console.log("⚠️ Disconnected from Telegram");
      ready = false;
      clearInterval(connectionCheckTimer);
      reconnectTelegram();
    });

    client.on('error', (err) => {
      console.error("Telegram client error:", err);
    });

  } catch (error) {
    console.error(`❌ Connection failed on DC${currentDc}:`, error.message);
    
    // Try next DC with exponential backoff
    if (currentDc < 5) {
      currentDc++;
      reconnectAttempts = 0;
      console.log(`Trying next DC (${currentDc})...`);
      setTimeout(connectTelegram, 3000);
    } else {
      reconnectAttempts++;
      if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
        const delay = Math.min(30000 * reconnectAttempts, 300000); // Max 5 minutes
        console.error(`All DCs failed. Retry ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay/1000} seconds.`);
        currentDc = 2; // Reset to DC2
        setTimeout(connectTelegram, delay);
      } else {
        console.error("Max reconnection attempts reached. Please check your configuration.");
      }
    }
  }
}

function reconnectTelegram() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  console.log("Scheduling reconnection in 5 seconds...");
  reconnectTimer = setTimeout(() => {
    console.log("Attempting to reconnect...");
    connectTelegram();
  }, 5000);
}

// Start Telegram connection
connectTelegram();

// Start download
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
    return res.status(400).json({ 
      error: "URL not supported. Please use YouTube, TikTok, Instagram, Facebook, Pinterest, Twitter, Reddit, Vimeo, or Dailymotion" 
    });
  }

  try {
    // Ensure we have a connection before proceeding
    await ensureConnection();
  } catch (error) {
    return res.status(503).json({ error: "Telegram not connected, please try again in a few seconds" });
  }

  console.log(`Processing ${platform} URL: ${url}`);
  const id = Date.now().toString();
  
  // Initialize progress
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
          
          // Get total size for progress tracking
          let total = 1;
          if (msg.media?.document) {
            total = msg.media.document.size || 1;
          } else if (msg.media?.photo) {
            total = msg.media.photo.sizes?.pop()?.bytes || 1;
            fileExt = "jpg";
            fileType = "image";
          }

          // Download with progress callback
          buffer = await client.downloadMedia(msg, {
            progressCallback: (received) => {
              const percent = Math.floor((received / total) * 100);
              progressMap.set(id, percent);
              console.log(`Progress ${id}: ${percent}%`);
            },
          });

          const dir = path.join(__dirname, "temp");
          if (!fs.existsSync(dir)) fs.mkdirSync(dir);

          const fileName = `content_${id}.${fileExt}`;
          const filePath = path.join(dir, fileName);
          fs.writeFileSync(filePath, buffer);

          files.set(id, { path: filePath, type: fileType });
          progressMap.set(id, 100); // Set to 100% when complete
          console.log(`Download complete ${id}: 100%`);

        } catch (error) {
          console.error(`Download failed:`, error);
          progressMap.set(id, -1); // Set to -1 on error
        }

        client.removeEventHandler(handler);
      }
    };

    client.addEventHandler(handler, new NewMessage({}));
    
    res.json({ id, platform });

  } catch (error) {
    console.error("Failed to process download:", error);
    progressMap.delete(id);
    res.status(500).json({ error: "Failed to process download" });
  }
});

// Get progress
app.get("/api/progress/:id", (req, res) => {
  const progress = progressMap.get(req.params.id);
  
  if (progress === undefined) {
    return res.status(404).json({ error: "Progress not found" });
  }
  
  res.json({ progress });
});

// Download file
app.get("/api/file/:id", (req, res) => {
  const fileData = files.get(req.params.id);

  if (!fileData || !fs.existsSync(fileData.path)) {
    return res.status(404).json({ error: "File not found" });
  }

  const fileName = fileData.type === "image" ? "image.jpg" : "video.mp4";
  
  res.download(fileData.path, fileName, () => {
    // Clean up after download
    fs.unlinkSync(fileData.path);
    files.delete(req.params.id);
    progressMap.delete(req.params.id);
    console.log(`Cleaned up ${req.params.id}`);
  });
});

// Get file info (check if ready)
app.get("/api/info/:id", (req, res) => {
  const fileData = files.get(req.params.id);
  const progress = progressMap.get(req.params.id);
  
  res.json({ 
    exists: !!fileData && fs.existsSync(fileData.path),
    type: fileData?.type || null,
    progress: progress || 0
  });
});

app.listen(PORT, () => {
  console.log("Server running on", PORT);
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  if (err.message.includes('getaddrinfo') || err.message.includes('EINVAL') || err.message.includes('Not connected')) {
    console.log('Connection issue detected, restarting connection...');
    ready = false;
    clearInterval(connectionCheckTimer);
    clearTimeout(reconnectTimer);
    reconnectTelegram();
  }
});