import { createServer } from "node:http";
import { createInterface } from "node:readline";

const socketPath = process.env.PAPPAI_HTTP_SOCKET;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!socketPath || !secret) {
  throw new Error("Set PAPPAI_HTTP_SOCKET and TELEGRAM_WEBHOOK_SECRET");
}

const maxBodyBytes = 1024 * 1024;

function receiveUpdate(req, res) {
  if (req.headers["x-telegram-bot-api-secret-token"] !== secret) {
    res.writeHead(403).end();
    return;
  }

  let size = 0;
  const chunks = [];
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size <= maxBodyBytes) {
      chunks.push(chunk);
    } else if (!res.writableEnded) {
      chunks.length = 0;
      res.writeHead(413).end();
    }
  });
  req.on("error", () => res.destroy());
  req.on("end", () => {
    if (res.writableEnded) return;
    let update;
    try {
      update = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (!Number.isSafeInteger(update?.update_id)) {
      res.writeHead(400).end();
      return;
    }
    // This example records the update ID in the APP log.
    console.error("Telegram update", update.update_id);
    res.writeHead(200).end("ok\n");
  });
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, {"Content-Type": "text/plain"}).end("ok\n");
  } else if (req.method === "POST" && req.url === "/webhook") {
    receiveUpdate(req, res);
  } else {
    res.writeHead(404).end();
  }
});

// The first event on stdin starts the listener. Drain subsequent events
// without creating another HTTP server.
const input = createInterface({input: process.stdin});
input.once("line", () => server.listen(socketPath));

function stop() {
  input.close();
  process.stdin.pause();
  server.close();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
