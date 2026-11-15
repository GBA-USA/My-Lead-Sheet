import { enqueue, flushQueue, withoutQueued, type ChatMessage, type Queued } from "./chat-model";
import { ApiError, api } from "./sign-in-methods";

/** What became of a queued message: the room stored it, or refused it for good. */
export type Delivery = (item: Queued, outcome: { message: ChatMessage } | { error: unknown }) => void;

const QUEUE_KEY = "leadSheetsChatQueue";
const RETRY_MS = 10_000;

function read(): Queued[] {
  try {
    const queue = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
    return Array.isArray(queue) ? queue : [];
  } catch {
    return [];
  }
}

/** Everyone's unsent messages on this phone. Only the signed-in account's are shown or sent; the rest wait for their writer to sign in again. */
let all = read();
let owner: string | null = null;
let mine: Queued[] = [];
const listeners = new Set<() => void>();
const deliveries = new Set<Delivery>();
let running: Promise<void> | null = null;
let addedWhileRunning = false;
let retry: ReturnType<typeof setInterval> | undefined;

function refresh() {
  mine = all.filter((item) => item.from === owner);
  if (mine.length > 0 && retry === undefined) retry = setInterval(sendQueued, RETRY_MS);
  if (mine.length === 0 && retry !== undefined) {
    clearInterval(retry);
    retry = undefined;
  }
  for (const listener of listeners) listener();
}

function set(next: Queued[]) {
  all = next;
  try {
    if (next.length === 0) localStorage.removeItem(QUEUE_KEY);
    else localStorage.setItem(QUEUE_KEY, JSON.stringify(next));
  } catch {}
  refresh();
}

/** The server never answered, so the message keeps waiting. A refusal it did give is final. */
const unanswered = (error: unknown) => !(error instanceof ApiError) || error.status === 0 || error.status >= 500;

const post = (item: Queued) => api<{ message: ChatMessage }>("/api/chat/send", { roomId: item.roomId, msgId: item.msgId, text: item.text }).then((reply) => reply.message);

/** The signed-in account's messages still waiting for signal, for `useSyncExternalStore`. The same array until something changes. */
export const queuedMessages = () => mine;

export function onQueueChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function onDelivery(delivery: Delivery): () => void {
  deliveries.add(delivery);
  return () => deliveries.delete(delivery);
}

/** Who is signed in on this phone, so the queue sends only what they wrote, and sends it as soon as they are known. */
export function queueOwner(userId: string | null) {
  if (userId === owner) return;
  owner = userId;
  refresh();
  void sendQueued();
}

/** Sends the signed-in account's waiting messages, one run at a time. A message queued during a run goes out right after it. */
export function sendQueued(): Promise<void> {
  if (running) return running;
  const deliver = (item: Queued, outcome: Parameters<Delivery>[1]) => {
    set(withoutQueued(all, item.msgId));
    for (const delivery of deliveries) delivery(item, outcome);
  };
  running = flushQueue(mine, post, unanswered, {
    sent: (item, message) => deliver(item, { message }),
    dropped: (item, error) => deliver(item, { error }),
  }).then(() => {
    running = null;
    if (!addedWhileRunning) return;
    addedWhileRunning = false;
    return sendQueued();
  });
  return running;
}

export function queueMessage(item: Queued) {
  set(enqueue(all, item));
  addedWhileRunning = running !== null;
  void sendQueued();
}

if (typeof addEventListener === "function") addEventListener("online", () => void sendQueued());
