import cluster from "cluster";
import os from "os";
import net from "net";
import { createHash } from "crypto";

const cpus = os.availableParallelism?.() || os.cpus().length;
const WORKER_COUNT = parseInt(process.env.WORKER_COUNT || String(Math.max(1, cpus - 1)), 10);
const PORT = parseInt(process.env.PORT || "3000", 10);
const INTERNAL_BASE = PORT + 1;

if (cluster.isPrimary) {
  console.log(`🚀 Primary process ${process.pid} starting ${WORKER_COUNT} workers on port ${PORT}`);

  let workerCount = 0;
  let proxyServer = null;

  for (let i = 0; i < WORKER_COUNT; i++) {
    const env = { ...process.env, PORT: String(INTERNAL_BASE + i), CLUSTER_WORKER_INDEX: String(i) };
    const worker = cluster.fork(env);
    worker.on("message", (msg) => {
      if (msg?.type === "ready") {
        workerCount++;
        if (workerCount === WORKER_COUNT) {
          console.log(`✅ All ${WORKER_COUNT} workers ready`);
          startProxy();
        }
      }
    });
  }

  cluster.on("exit", (worker, code, signal) => {
    workerCount--;
    console.log(`❌ Worker ${worker.process.pid} exited (code: ${code}, signal: ${signal})`);
    if (signal !== "SIGTERM" && signal !== "SIGINT") {
      console.log(`🔄 Restarting worker...`);
      const i = parseInt(worker.env?.CLUSTER_WORKER_INDEX || "0", 10);
      const env = { ...process.env, PORT: String(INTERNAL_BASE + i), CLUSTER_WORKER_INDEX: String(i) };
      const newWorker = cluster.fork(env);
      newWorker.on("message", (msg) => {
        if (msg?.type === "ready") workerCount++;
      });
    }
  });

  function startProxy() {
    proxyServer = net.createServer((clientSocket) => {
      const ip = clientSocket.remoteAddress || "127.0.0.1";
      const hash = createHash("md5").update(ip).digest("hex");
      const workerIndex = parseInt(hash.substring(0, 8), 16) % WORKER_COUNT;
      const targetPort = INTERNAL_BASE + workerIndex;

      const workerSocket = net.createConnection({ port: targetPort }, () => {
        workerSocket.pipe(clientSocket);
        clientSocket.pipe(workerSocket);
      });

      workerSocket.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => workerSocket.destroy());
    });

    proxyServer.listen(PORT, () => {
      console.log(`🌐 Sticky TCP proxy listening on port ${PORT}`);
    });

    proxyServer.on("error", (err) => {
      console.error("❌ Proxy server error:", err.message);
    });
  }

  process.on("SIGTERM", () => {
    console.log("⚠️  Primary received SIGTERM, shutting down proxy and workers...");
    if (proxyServer) proxyServer.close();
    for (const id in cluster.workers) {
      cluster.workers[id].kill("SIGTERM");
    }
  });

  process.on("SIGINT", () => {
    console.log("⚠️  Primary received SIGINT, shutting down proxy and workers...");
    if (proxyServer) proxyServer.close();
    for (const id in cluster.workers) {
      cluster.workers[id].kill("SIGTERM");
    }
  });
} else {
  process.on("message", (msg) => {
    if (msg?.type === "shutdown") process.exit(0);
  });

  await import("./main.js");

  if (process.send) {
    process.send({ type: "ready" });
  }
}
