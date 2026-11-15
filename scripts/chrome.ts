import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { build } from "vite";

const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml" };

export interface Site {
  origin: string;
  send(method: string, params?: object): Promise<any>;
  evaluate<T>(expression: string): Promise<T>;
  close(): Promise<void>;
}

async function forward(request: IncomingMessage, response: ServerResponse, apiBase: string) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const headers = Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[0] !== "host"));
  const reply = await fetch(new URL(request.url ?? "/", apiBase), { method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: "manual" });
  const location = reply.headers.get("location");
  response.writeHead(reply.status, { "content-type": reply.headers.get("content-type") ?? "application/json", "set-cookie": reply.headers.getSetCookie(), ...(location ? { location } : {}) });
  response.end(Buffer.from(await reply.arrayBuffer()));
}

/**
 * Builds the app, serves it on a free port, and opens one tab of headless Chrome on DevTools.
 * With `apiBase`, requests under /api/ and code links under /c/ go on to the API it returns, so the page talks to a real Worker.
 * `flags` go on Chrome's command line, for example a fake camera.
 */
export async function openSite(root: string, name: string, apiBase?: () => string, flags: string[] = []): Promise<Site> {
  const out = mkdtempSync(join(tmpdir(), `${name}-`));
  await build({ root, logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (apiBase && (path.startsWith("/api/") || path.startsWith("/c/"))) {
      forward(request, response, apiBase()).catch(() => {
        response.writeHead(502);
        response.end();
      });
      return;
    }
    const file = join(out, path === "/" ? "index.html" : path);
    try {
      const body = readFileSync(file);
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  const profile = mkdtempSync(join(tmpdir(), `${name}-chrome-`));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", ...flags, "about:blank"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const endpoint = await new Promise<string>((resolve, reject) => {
    let log = "";
    chrome.stderr.on("data", (chunk) => {
      log += chunk;
      const found = log.match(/DevTools listening on (ws:\S+)/);
      if (found) resolve(found[1]);
    });
    chrome.on("exit", () => reject(new Error(`Chrome exited before DevTools was up:\n${log}`)));
  });

  const socket = new WebSocket(endpoint);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  let nextId = 0;
  let sessionId: string | undefined;
  const send = (method: string, params: object = {}): Promise<any> => {
    const id = (nextId += 1);
    socket.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const evaluate = async <T>(expression: string): Promise<T> => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).catch((error: Error) => {
      throw new Error(`${error.message} in: ${expression.slice(0, 120)}`);
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value as T;
  };

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  sessionId = (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;

  const close = async () => {
    socket.close();
    chrome.kill();
    server.close();
    await new Promise((resolve) => (chrome.exitCode === null ? chrome.once("exit", resolve) : resolve(null)));
    rmSync(profile, { recursive: true, force: true, maxRetries: 10 });
    rmSync(out, { recursive: true, force: true });
  };
  return { origin, send, evaluate, close };
}
