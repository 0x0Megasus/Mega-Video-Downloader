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
app.use(cors({ origin: process.env.CLIENT_URL }));

const PORT = process.env.PORT || 5000;

// State
const progressMap = new Map();
const files = new Map();

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

// ============================================
// TELEGRAM CONNECTION - FINAL FIXED VERSION
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
// KEEP-ALIVE - FIXED VERSION
// ============================================

// Don't let keep-alive failures affect ready state
setInterval(async () => {
  if (client) {
    try {
      await client.invoke(new Api.ping.Ping({ 
        ping_id: BigInt(Date.now()) 
      }));
      console.log("💓 Keep-alive OK");
      
      // If we get here, connection is good - ensure ready is true
      if (!ready) {
        console.log("✅ Connection restored, marking as ready");
        ready = true;
      }
    } catch (err) {
      console.log("💓 Keep-alive failed (temporary)");
      // DON'T set ready = false here
      // Let the next request try to use the connection
      // If it's really dead, the download endpoint will handle it
    }
  }
}, 45000); // Check every 45 seconds

// Also verify connection before downloads
async function ensureConnection() {
  if (!client) {
    throw new Error("Telegram client not initialized");
  }
  
  if (!ready) {
    // Try a quick ping to see if connection is actually dead
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
// API ENDPOINTS
// ============================================

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
      error: "URL not supported" 
    });
  }

  // Check connection before proceeding
  try {
    await ensureConnection();
  } catch (error) {
    return res.status(503).json({ error: "Telegram connecting, please wait..." });
  }

  console.log(`Processing ${platform} URL: ${url}`);
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

          const fileName = `content_${id}.${fileExt}`;
          const filePath = path.join(dir, fileName);
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
    fs.unlinkSync(fileData.path);
    files.delete(req.params.id);
    progressMap.delete(req.params.id);
  });
});

// Get file info
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

// Debug - log ready state periodically
setInterval(() => {
  console.log(`📊 Status - Ready: ${ready}, Client: ${!!client}`);
}, 30000);

// Handle errors gracefully
process.on('uncaughtException', (err) => {
  console.error('Fatal error:', err.message);
  // Don't exit on keep-alive errors
  if (!err.message.includes('ping') && !err.message.includes('Ping')) {
    process.exit(1);
  }
});