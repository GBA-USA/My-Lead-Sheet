import { createHash, createHmac, randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";

const COOKIE = 0x2112a442;
const METHOD = { allocate: 0x003, refresh: 0x004, send: 0x006, data: 0x007, permission: 0x008, channelBind: 0x009 };
const ATTR = {
  username: 0x0006, integrity: 0x0008, error: 0x0009, channel: 0x000c, lifetime: 0x000d, peer: 0x0012,
  data: 0x0013, realm: 0x0014, nonce: 0x0015, relayed: 0x0016, mapped: 0x0020,
};
const REALM = "spike.local";

function parseAttrs(message) {
  const attrs = new Map();
  for (let at = 20; at + 4 <= message.length; ) {
    const type = message.readUInt16BE(at);
    const length = message.readUInt16BE(at + 2);
    attrs.set(type, { value: message.subarray(at + 4, at + 4 + length), at });
    at += 4 + Math.ceil(length / 4) * 4;
  }
  return { get: (type) => attrs.get(type)?.value, at: (type) => attrs.get(type)?.at };
}

function attr(type, value) {
  const out = Buffer.alloc(4 + Math.ceil(value.length / 4) * 4);
  out.writeUInt16BE(type, 0);
  out.writeUInt16BE(value.length, 2);
  value.copy(out, 4);
  return out;
}

function xorAddress(address, port) {
  const out = Buffer.alloc(8);
  out.writeUInt16BE(0x0001, 0);
  out.writeUInt16BE(port ^ (COOKIE >>> 16), 2);
  const ip = address.split(".").reduce((n, part) => (n << 8) | Number(part), 0) >>> 0;
  out.writeUInt32BE((ip ^ COOKIE) >>> 0, 4);
  return out;
}

function readXorAddress(value) {
  const port = value.readUInt16BE(2) ^ (COOKIE >>> 16);
  const ip = (value.readUInt32BE(4) ^ COOKIE) >>> 0;
  return { address: [24, 16, 8, 0].map((shift) => (ip >>> shift) & 255).join("."), port };
}

function build(type, transaction, attrs, key) {
  const body = Buffer.concat(attrs);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(body.length + (key ? 24 : 0), 2);
  header.writeUInt32BE(COOKIE, 4);
  transaction.copy(header, 8);
  const message = Buffer.concat([header, body]);
  if (!key) return message;
  return Buffer.concat([message, attr(ATTR.integrity, createHmac("sha1", key).update(message).digest())]);
}

function validIntegrity(message, attrs, key) {
  const integrity = attrs.get(ATTR.integrity);
  if (!integrity) return false;
  const at = attrs.at(ATTR.integrity);
  const signed = Buffer.from(message.subarray(0, at));
  signed.writeUInt16BE(at - 20 + 24, 2);
  return createHmac("sha1", key).update(signed).digest().equals(integrity);
}

export function startLocalTurn({ username, credential, host = "127.0.0.1" }) {
  const key = createHash("md5").update(`${username}:${REALM}:${credential}`).digest();
  const nonce = Buffer.from(randomBytes(8).toString("hex"));
  const stats = { allocations: 0, relayedBytes: 0, droppedNoPermission: 0 };
  const sockets = new Set();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    let pending = Buffer.alloc(0);
    let relay = null;
    const permitted = new Set();
    const channels = new Map();
    const peersToChannel = new Map();
    const reply = (method, klass, transaction, attrs, signed = true) => socket.write(build(method | (klass === "ok" ? 0x100 : 0x110), transaction, attrs, signed ? key : null));
    const fail = (method, transaction, code, reason) => {
      const value = Buffer.concat([Buffer.from([0, 0, Math.floor(code / 100), code % 100]), Buffer.from(reason)]);
      reply(method, "error", transaction, [attr(ATTR.error, value), attr(ATTR.realm, Buffer.from(REALM)), attr(ATTR.nonce, nonce)], false);
    };

    const onStun = (message) => {
      const type = message.readUInt16BE(0);
      const method = (type & 0x000f) | ((type & 0x00e0) >> 1) | ((type & 0x3e00) >> 2);
      const transaction = message.subarray(8, 20);
      const attrs = parseAttrs(message);
      if (method === METHOD.send) {
        const peer = readXorAddress(attrs.get(ATTR.peer));
        if (relay && permitted.has(peer.address)) relay.send(attrs.get(ATTR.data), peer.port, peer.address);
        return;
      }
      if (attrs.get(ATTR.username)?.toString() !== username || !validIntegrity(message, attrs, key)) return fail(method, transaction, 401, "Unauthorized");
      if (method === METHOD.allocate) {
        if (relay) return fail(method, transaction, 437, "Allocation Mismatch");
        relay = createSocket("udp4");
        relay.on("message", (data, from) => {
          if (!permitted.has(from.address)) return stats.droppedNoPermission++;
          stats.relayedBytes += data.length;
          const channel = peersToChannel.get(`${from.address}:${from.port}`);
          if (channel !== undefined) {
            const frame = Buffer.alloc(4 + Math.ceil(data.length / 4) * 4);
            frame.writeUInt16BE(channel, 0);
            frame.writeUInt16BE(data.length, 2);
            data.copy(frame, 4);
            socket.write(frame);
          } else {
            socket.write(build(0x0017, randomBytes(12), [attr(ATTR.peer, xorAddress(from.address, from.port)), attr(ATTR.data, data)]));
          }
        });
        relay.bind(0, host, () => {
          stats.allocations++;
          const lifetime = Buffer.alloc(4);
          lifetime.writeUInt32BE(600);
          reply(method, "ok", transaction, [
            attr(ATTR.relayed, xorAddress(host, relay.address().port)),
            attr(ATTR.mapped, xorAddress(socket.remoteAddress.replace(/^::ffff:/, ""), socket.remotePort)),
            attr(ATTR.lifetime, lifetime),
          ]);
        });
        return;
      }
      if (method === METHOD.refresh) return reply(method, "ok", transaction, [attr(ATTR.lifetime, attrs.get(ATTR.lifetime) ?? Buffer.alloc(4))]);
      if (method === METHOD.permission) {
        permitted.add(readXorAddress(attrs.get(ATTR.peer)).address);
        return reply(method, "ok", transaction, []);
      }
      if (method === METHOD.channelBind) {
        const channel = attrs.get(ATTR.channel).readUInt16BE(0);
        const peer = readXorAddress(attrs.get(ATTR.peer));
        permitted.add(peer.address);
        channels.set(channel, peer);
        peersToChannel.set(`${peer.address}:${peer.port}`, channel);
        return reply(method, "ok", transaction, []);
      }
      fail(method, transaction, 400, "Bad Request");
    };

    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const first = pending.readUInt16BE(0);
        const isChannel = first >= 0x4000 && first <= 0x7fff;
        const length = isChannel ? 4 + Math.ceil(pending.readUInt16BE(2) / 4) * 4 : 20 + pending.readUInt16BE(2);
        if (pending.length < length) return;
        const frame = pending.subarray(0, length);
        pending = pending.subarray(length);
        if (!isChannel) onStun(frame);
        else if (relay && channels.has(first)) {
          const peer = channels.get(first);
          relay.send(frame.subarray(4, 4 + frame.readUInt16BE(2)), peer.port, peer.address);
        }
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      relay?.close();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, host, () =>
      resolve({
        url: `turn:${host}:${server.address().port}?transport=tcp`,
        stats,
        close: () => {
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => server.close(done));
        },
      }),
    );
  });
}
