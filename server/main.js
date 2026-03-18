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
const progressMap = new Map(); // id -> progress
const files = new Map(); // id -> { buffer, type, ext, mime }

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
// API ENDPOINTS - FIXED FOR IMAGES
// ============================================

// Start download - FIXED FOR IMAGES (NO MP4 FOR IMAGES)
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

      // Handle BOTH document (videos) AND photo (images)
      if (msg.media) {
        try {
          let buffer;
          let fileType = "unknown";
          let fileExt = "bin";
          let total = 1;
          let mimeType = "";
          
          // CASE 1: It's a photo (image)
          if (msg.media.photo) {
            console.log("📸 Detected image (photo type)");
            fileType = "image";
            fileExt = "jpg";
            mimeType = "image/jpeg";
            
            // Get photo size
            if (msg.media.photo.sizes && msg.media.photo.sizes.length > 0) {
              const sizes = msg.media.photo.sizes;
              const largestSize = sizes[sizes.length - 1];
              total = largestSize?.bytes || 1;
            }
            
            // Download photo
            buffer = await client.downloadMedia(msg, {
              progressCallback: (received) => {
                const percent = Math.floor((received / total) * 100);
                progressMap.set(id, percent);
              },
            });
          }
          // CASE 2: It's a document
          else if (msg.media.document) {
            total = msg.media.document.size || 1;
            mimeType = msg.media.document.mimeType || "";
            
            // Check if it's an image document
            if (mimeType.startsWith("image/")) {
              console.log("📸 Detected image document");
              fileType = "image";
              fileExt = mimeType.split("/")[1] || "jpg";
              if (fileExt === "jpeg") fileExt = "jpg";
            } 
            // Check if it's a video
            else if (mimeType.startsWith("video/")) {
              console.log("🎥 Detected video file");
              fileType = "video";
              fileExt = "mp4";
            }
            // Check if it's a GIF
            else if (mimeType === "image/gif") {
              console.log("🎞️ Detected GIF");
              fileType = "image";
              fileExt = "gif";
            }
            else {
              console.log("📁 Detected unknown file type:", mimeType);
              fileType = "unknown";
              fileExt = "bin";
            }
            
            // Download document
            buffer = await client.downloadMedia(msg, {
              progressCallback: (received) => {
                const percent = Math.floor((received / total) * 100);
                progressMap.set(id, percent);
              },
            });
          }

          if (buffer && buffer.length > 0) {
            // Store the buffer with correct type and extension
            files.set(id, { 
              buffer: buffer,
              type: fileType,
              ext: fileExt,
              mime: mimeType,
              size: total
            });
            
            progressMap.set(id, 100);
            console.log(`✅ Download complete for ${id} (${fileType}, ${fileExt}, ${(total/1024/1024).toFixed(2)} MB)`);
          } else {
            throw new Error("No media buffer received or buffer empty");
          }

        } catch (error) {
          console.error(`❌ Download failed:`, error);
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

// Download file endpoint - FIXED FOR IMAGES
app.get("/api/file/:id", async (req, res) => {
  const fileData = files.get(req.params.id);

  if (!fileData || !fileData.buffer) {
    return res.status(404).json({ error: "File not found or expired" });
  }

  // Set correct filename and content type based on file type
  let fileName;
  let contentType;
  
  if (fileData.type === "image") {
    fileName = `image.${fileData.ext}`;
    
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
        contentType = 'image/jpeg';
    }
  } else if (fileData.type === "video") {
    fileName = "video.mp4";
    contentType = "video/mp4";
  } else {
    fileName = `file.${fileData.ext}`;
    contentType = 'application/octet-stream';
  }
  
  // Set headers for download
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', fileData.buffer.length);
  
  // Send the buffer
  res.send(fileData.buffer);
  
  // Clean up after sending
  files.delete(req.params.id);
  progressMap.delete(req.params.id);
  console.log(`🧹 Cleaned up ${req.params.id} (${fileData.type})`);
});

// Get progress
app.get("/api/progress/:id", (req, res) => {
  const progress = progressMap.get(req.params.id);
  
  if (progress === undefined) {
    return res.status(404).json({ error: "Progress not found" });
  }
  
  res.json({ progress });
});

// Get file info
app.get("/api/info/:id", (req, res) => {
  const fileData = files.get(req.params.id);
  
  res.json({ 
    exists: !!(fileData && fileData.buffer),
    type: fileData?.type || null,
    ext: fileData?.ext || null,
    size: fileData?.buffer?.length || 0
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Debug - log ready state periodically
setInterval(() => {
  console.log(`📊 Status - Ready: ${ready}, Client: ${!!client}, Files: ${files.size}`);
}, 30000);

// Handle errors gracefully
process.on('uncaughtException', (err) => {
  console.error('💥 Fatal error:', err.message);
  // Don't exit on keep-alive errors
  if (!err.message.includes('ping') && !err.message.includes('Ping')) {
    process.exit(1);
  }
});