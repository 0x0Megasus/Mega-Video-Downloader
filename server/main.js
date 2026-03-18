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

// Force IPv4 and use reliable DNS
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '1.1.1.1']);

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

// Telegram DC addresses
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

async function connectTelegram() {
  try {
    console.log(`Attempting to connect to Telegram DC${currentDc}...`);
    
    // Use the GLOBAL variables
    if (!API_ID || !API_HASH || !SESSION) {
      console.error("Missing required variables:", { 
        API_ID: !!API_ID, 
        API_HASH: !!API_HASH, 
        SESSION: !!SESSION 
      });
      throw new Error("Missing required environment variables");
    }

    // Create client with forced connection settings
    client = new TelegramClient(
      new StringSession(SESSION),
      API_ID,
      API_HASH,
      {
        connectionRetries: 5,
        useWSS: false,
        baseDc: currentDc,
        ipVersion: 4,
        deviceModel: "Railway Server",
        systemVersion: "Linux",
        appVersion: "1.0.0",
        langCode: "en",
        timeout: 30,
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
    console.log(`✅ Telegram connected successfully on DC${currentDc}`);

    // Set up reconnection handler
    client.addEventHandler((update) => {
      if (update.className === 'UpdateUserStatus') {
        console.log("Connection status changed");
      }
    });

  } catch (error) {
    console.error(`❌ Connection failed on DC${currentDc}:`, error.message);
    
    // Try next DC
    if (currentDc < 5) {
      currentDc++;
      console.log(`Trying next DC (${currentDc})...`);
      setTimeout(connectTelegram, 3000);
    } else {
      console.error("All DCs failed. Will retry from DC1 in 30 seconds.");
      currentDc = 1;
      setTimeout(connectTelegram, 30000);
    }
  }
}

// Start Telegram connection
connectTelegram();

// Rest of your routes remain exactly the same...
// (Keep all your app.post, app.get routes from your previous code)

app.post("/api/download", async (req, res) => {
  // ... your existing download code ...
});

app.get("/api/progress/:id", (req, res) => {
  // ... your existing progress code ...
});

app.get("/api/file/:id", (req, res) => {
  // ... your existing file code ...
});

app.get("/api/info/:id", (req, res) => {
  // ... your existing info code ...
});

app.listen(PORT, () => {
  console.log("Server running on", PORT);
});