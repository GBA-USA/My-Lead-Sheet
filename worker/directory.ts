import { DurableObject } from "cloudflare:workers";
import { codeLanding, CODE_ROUTES, createCodeTables, LANDING_PATH } from "./codes";
import { ACCOUNT_ROUTES, authorizeRoom, closeRooms, createAccountTables } from "./directory-account";
import { handleDirectoryRequest } from "./directory-http";
import { createFriendTables, FRIEND_ROUTES } from "./directory-friends";
import { CHAT_ROUTES, createInboxTables } from "./directory-inbox";
import type { Env } from "./index";
import { EXPORT_ROUTES } from "./room-export";
import { LIBRARY_ROUTES } from "./room-library";
import { BAND_ROUTES, createBandIndex } from "./room-members";

const ROUTES = { ...ACCOUNT_ROUTES, ...CODE_ROUTES, ...FRIEND_ROUTES, ...BAND_ROUTES, ...LIBRARY_ROUTES, ...CHAT_ROUTES, ...EXPORT_ROUTES };

export class Directory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    createAccountTables(ctx.storage.sql);
    createCodeTables(ctx.storage.sql);
    createFriendTables(ctx.storage.sql);
    createBandIndex(ctx.storage.sql);
    createInboxTables(ctx.storage.sql);
  }

  fetch(request: Request): Promise<Response> {
    const landing = request.method === "GET" ? LANDING_PATH.exec(new URL(request.url).pathname)?.[1] : undefined;
    if (landing) return codeLanding(this.ctx.storage.sql, this.env, landing);
    return handleDirectoryRequest(request, this.ctx.storage, this.env, ROUTES);
  }

  authorizeRoom(userId: string, version: number, roomId: string): boolean {
    return authorizeRoom(this.ctx.storage.sql, userId, version, roomId);
  }

  alarm(): Promise<void> {
    return closeRooms(this.ctx.storage, this.env);
  }
}
