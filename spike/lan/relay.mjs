import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTurnConfig } from "../cell/turn.mjs";

const SPIKE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const QRCODE = fileURLToPath(new URL("../../node_modules/qrcode-generator/qrcode.js", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
const SERVED = /^\/(lan|cell)\/[\w.-]+\.(html|js|css)$/;
const SIGNAL = /^\/signal\/([\w-]{1,64})\/([\w-]{1,64})$/;
const MAX_BODY = 32 * 1024;
const MAX_QUEUE = 200;
const POLL_MS = 20_000;
const HEALTH = { service: "mls-spike-links" };

export function createRelay({ env = process.env } = {}) {
  const boxes = new Map();
  const box = (room, who) => {
    const key = `${room}/${who}`;
    if (!boxes.has(key)) boxes.set(key, { next: 1, messages: [], waiters: new Set() });
    return boxes.get(key);
  };

  const json = (response, status, body) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };

  const readBody = (request) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) reject(new Error("too large"));
        else chunks.push(chunk);
      });
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      request.on("error", reject);
    });

  const post = async (request, response, mailbox) => {
    let message;
    try {
      message = JSON.parse(await readBody(request));
    } catch {
      return json(response, 400, { error: "bad message" });
    }
    const seq = mailbox.next++;
    mailbox.messages.push({ seq, message });
    if (mailbox.messages.length > MAX_QUEUE) mailbox.messages.shift();
    for (const wake of mailbox.waiters) wake();
    json(response, 200, { seq });
  };

  const poll = (url, response, mailbox) => {
    if (!url.searchParams.has("after")) return json(response, 200, { messages: [], cursor: mailbox.next - 1 });
    const after = Number(url.searchParams.get("after"));
    const pending = () => mailbox.messages.filter((m) => m.seq > after);
    if (pending().length) return json(response, 200, { messages: pending() });
    const done = () => {
      clearTimeout(timer);
      mailbox.waiters.delete(done);
      if (!response.writableEnded) json(response, 200, { messages: pending() });
    };
    const timer = setTimeout(done, POLL_MS);
    mailbox.waiters.add(done);
    response.on("close", done);
  };

  const serveFile = async (response, path) => {
    try {
      const body = await readFile(path);
      response.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  };

  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://relay");
    const signal = url.pathname.match(SIGNAL);
    if (signal && request.method === "POST") return post(request, response, box(signal[1], signal[2]));
    if (signal && request.method === "GET") return poll(url, response, box(signal[1], signal[2]));
    if (url.pathname === "/health") return json(response, 200, HEALTH);
    if (url.pathname === "/turn") return json(response, 200, readTurnConfig(env));
    if (url.pathname === "/vendor/qrcode.js") return serveFile(response, QRCODE);
    if (url.pathname === "/") {
      response.writeHead(302, { location: "/lan/" });
      return response.end();
    }
    const path = url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname;
    if (!SERVED.test(path)) {
      response.writeHead(404);
      return response.end();
    }
    return serveFile(response, join(SPIKE_ROOT, path));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "0.0.0.0";
  createRelay().listen(port, host, () => {
    const turn = readTurnConfig();
    console.log(`spike relay on http://${host}:${port}/lan/ and /cell/`);
    console.log(turn.turn ? `TURN: ${turn.turn.urls.length} relay addresses loaded` : "TURN: not configured, relay attempts will be skipped");
  });
}
