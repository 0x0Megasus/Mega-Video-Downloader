import cluster from "cluster";
import os from "os";

const cpus = os.availableParallelism?.() || os.cpus().length;
const WORKER_COUNT = parseInt(process.env.WORKER_COUNT || String(Math.max(1, cpus - 1)), 10);

if (cluster.isPrimary) {
  console.log(`🚀 Primary process ${process.pid} starting ${WORKER_COUNT} workers...`);

  let workerCount = 0;

  for (let i = 0; i < WORKER_COUNT; i++) {
    const worker = cluster.fork();
    worker.on("message", (msg) => {
      if (msg?.type === "ready") {
        workerCount++;
        if (workerCount === WORKER_COUNT) {
          console.log(`✅ All ${WORKER_COUNT} workers ready`);
        }
      }
    });
  }

  cluster.on("exit", (worker, code, signal) => {
    workerCount--;
    console.log(`❌ Worker ${worker.process.pid} exited (code: ${code}, signal: ${signal})`);

    if (signal !== "SIGTERM" && signal !== "SIGINT") {
      console.log(`🔄 Restarting worker...`);
      const newWorker = cluster.fork();
      newWorker.on("message", (msg) => {
        if (msg?.type === "ready") workerCount++;
      });
    }
  });

  process.on("SIGTERM", () => {
    console.log("⚠️  Primary received SIGTERM, shutting down workers...");
    for (const id in cluster.workers) {
      cluster.workers[id].kill("SIGTERM");
    }
  });

  process.on("SIGINT", () => {
    console.log("⚠️  Primary received SIGINT, shutting down workers...");
    for (const id in cluster.workers) {
      cluster.workers[id].kill("SIGTERM");
    }
  });
} else {
  process.on("message", (msg) => {
    if (msg?.type === "shutdown") {
      process.exit(0);
    }
  });

  await import("./main.js");

  if (process.send) {
    process.send({ type: "ready" });
  }
}
