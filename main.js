import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static("public"));

const server = app.listen(process.env.PORT || 3000);
const wss = new WebSocketServer({ server });

let wsClient = null;
wss.on("connection", (ws) => {
  wsClient = ws;
});

const client = new TelegramClient(
  new StringSession(process.env.SESSION),
  Number(process.env.API_ID),
  process.env.API_HASH,
  { connectionRetries: 5 }
);

let bot;

(async () => {
  await client.start();
  bot = await client.getEntity(process.env.BOT_USERNAME);
})();

app.post("/download", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).send("No URL");

  await client.sendMessage(bot, { message: url });

  const handler = async (event) => {
    const msg = event.message;

    if (!msg.senderId || msg.senderId.value !== bot.id.value) return;

    if (msg.media && msg.media.document) {
      const total = msg.media.document.size || 1;
      let downloaded = 0;

      const buffer = await client.downloadMedia(msg, {
        progressCallback: (received) => {
          downloaded = received;
          const percent = Math.floor((downloaded / total) * 100);

          if (wsClient) {
            wsClient.send(JSON.stringify({ progress: percent }));
          }
        },
      });

      const filePath = path.join(__dirname, "video.mp4");
      fs.writeFileSync(filePath, buffer);

      client.removeEventHandler(handler);

      res.download(filePath, () => fs.unlinkSync(filePath));
    }
  };

  client.addEventHandler(handler, new NewMessage({}));
});