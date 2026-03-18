import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import cors from "cors";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";

dotenv.config();

// Debug environment variables
console.log("=== RAW ENVIRONMENT VARIABLES ===");
console.log("API_ID:", JSON.stringify(process.env.API_ID));
console.log("API_HASH:", JSON.stringify(process.env.API_HASH));
console.log("SESSION length:", process.env.SESSION?.length);
console.log("SESSION first 50 chars:", process.env.SESSION?.substring(0, 50));
console.log("BOT_USERNAME:", JSON.stringify(process.env.BOT_USERNAME));
console.log("=================================");

// Force clean the variables
const apiId = Number(process.env.API_ID?.trim());
const apiHash = process.env.API_HASH?.trim();
const session = process.env.SESSION?.trim();
const botUsername = process.env.BOT_USERNAME?.trim();

console.log("=== CLEANED VARIABLES ===");
console.log("API_ID (number):", apiId);
console.log("API_HASH length:", apiHash?.length);
console.log("SESSION length:", session?.length);
console.log("BOT_USERNAME:", botUsername);
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

// Telegram client
const client = new TelegramClient(
  new StringSession(process.env.SESSION || ""),
  Number(process.env.API_ID),
  process.env.API_HASH,
  { connectionRetries: 5 }
);

let bot;
let ready = false;

(async () => {
  await client.connect();

  if (!(await client.isUserAuthorized())) {
    console.log("Invalid session");
    process.exit(1);
  }

  bot = await client.getEntity(process.env.BOT_USERNAME);
  ready = true;
  console.log("Telegram ready");
})();

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

  if (!ready) {
    return res.status(503).json({ error: "Server is not ready yet" });
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