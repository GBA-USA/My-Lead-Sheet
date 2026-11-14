import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_FILE = fileURLToPath(new URL("./turn.local.json", import.meta.url));
const DEFAULT_STUN = "stun:stun.cloudflare.com:3478";

function list(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

export function readTurnConfig(env = process.env) {
  const stun = (env.SPIKE_STUN_URLS ?? DEFAULT_STUN).split(",").map((url) => url.trim()).filter(Boolean);
  const file = env.SPIKE_TURN_FILE ?? DEFAULT_FILE;
  const raw = env.SPIKE_TURN_ICE_SERVERS ?? (existsSync(file) ? readFileSync(file, "utf8") : null);
  if (!raw) return { stun, turn: null };
  const servers = list(JSON.parse(raw).iceServers).filter((server) => server.username && server.credential);
  if (servers.length === 0) return { stun, turn: null };
  const { username, credential } = servers[0];
  const urls = servers.flatMap((server) => list(server.urls)).filter((url) => /^turns?:/.test(url));
  return { stun, turn: { urls, username, credential } };
}
