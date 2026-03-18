import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import cors from "cors";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { Api } from "telegram/tl/index.js";

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

// Platform validation (simplified)
const isValidUrl = (string) => {
  try { new URL(string); return true; } catch { return false; }
};

const getPlatformFromUrl = (url) => {
  if (url.includes('youtube.com') || url.includes('youtu.be')) return "YouTube";
  if (url.includes('tiktok.com')) return "TikTok";
  if (url.includes('instagram.com')) return "Instagram";
  if (url.includes('facebook.com') || url.includes('fb.watch')) return "Facebook";
  if (url.includes('pinterest.com') || url.includes('pin.it')) return "Pinterest";
  if (url.includes('twitter.com') || url.includes('x.com')) return "Twitter";
  return null;
};

// Telegram connection
const API_ID = Number(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const SESSION = process.env.SESSION;
const BOT_USERNAME = process.env.BOT_USERNAME;

let client;
let bot;
let ready = false;

async function connectTelegram() {
  try {
    console.log("Connecting to Telegram...");
    
    client = new TelegramClient(
      new StringSession(SESSION),
      API_ID,
      API_HASH,
      { connectionRetries: 3, timeout: 30 }
    );

    await client.connect();

    if (!(await client.isUserAuthorized())) {
      throw new Error("Session expired");
    }

    bot = await client.getEntity(BOT_USERNAME);
    ready = true;
    console.log("✅ Telegram connected");

    // Simple keep-alive
    setInterval(async () => {
      if (client && ready) {
        try {
          await client.invoke(new Api.ping.Ping({ ping_id: BigInt(Date.now()) }));
        } catch (e) {
          console.log("Connection lost, will reconnect on next request");
          ready = false;
        }
      }
    }, 30000);

  } catch (error) {
    console.error("Connection failed:", error.message);
    setTimeout(connectTelegram, 10000);
  }
}

connectTelegram();

// Download endpoint
app.post("/api/download", async (req, res) => {
  const { url } = req.body;

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: "Invalid URL" });
  }

  const platform = getPlatformFromUrl(url);
  if (!platform) {
    return res.status(400).json({ error: "Unsupported platform" });
  }

  if (!ready) {
    return res.status(503).json({ error: "Telegram connecting..." });
  }

  const id = Date.now().toString();
  progressMap.set(id, 0);

  try {
    await client.sendMessage(bot, { message: url });

    const handler = async (event) => {
      const msg = event.message;
      if (!msg.senderId || msg.senderId.value !== bot.id.value) return;

      if (msg.media?.document || msg.media?.photo) {
        try {
          const buffer = await client.downloadMedia(msg);
          
          const dir = path.join(__dirname, "temp");
          if (!fs.existsSync(dir)) fs.mkdirSync(dir);

          const filePath = path.join(dir, `file_${id}.mp4`);
          fs.writeFileSync(filePath, buffer);

          files.set(id, { path: filePath, type: "video" });
          progressMap.set(id, 100);
        } catch (error) {
          progressMap.set(id, -1);
        }
        client.removeEventHandler(handler);
      }
    };

    client.addEventHandler(handler, new NewMessage({}));
    res.json({ id, platform });

  } catch (error) {
    progressMap.delete(id);
    res.status(500).json({ error: "Download failed" });
  }
});

// Progress endpoint
app.get("/api/progress/:id", (req, res) => {
  const p = progressMap.get(req.params.id);
  if (p === undefined) return res.status(404).json({ error: "Not found" });
  res.json({ progress: p });
});

// File endpoint
app.get("/api/file/:id", (req, res) => {
  const file = files.get(req.params.id);
  if (!file || !fs.existsSync(file.path)) {
    return res.status(404).json({ error: "Not found" });
  }
  res.download(file.path, "video.mp4", () => {
    fs.unlinkSync(file.path);
    files.delete(req.params.id);
    progressMap.delete(req.params.id);
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Let Railway handle crashes
process.on('uncaughtException', (err) => {
  console.error('Crash:', err.message);
  process.exit(1); // Railway will restart
});