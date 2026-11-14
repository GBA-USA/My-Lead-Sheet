import { DurableObject } from "cloudflare:workers";
import { authorizeRoom, closeRooms, createAccountTables, handleAccountRequest } from "./directory-account";
import type { Env } from "./index";

export class Directory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    createAccountTables(ctx.storage.sql);
  }

  fetch(request: Request): Promise<Response> {
    return handleAccountRequest(request, this.ctx.storage, this.env);
  }

  authorizeRoom(userId: string, version: number, roomId: string): boolean {
    return authorizeRoom(this.ctx.storage.sql, userId, version, roomId);
  }

  alarm(): Promise<void> {
    return closeRooms(this.ctx.storage, this.env);
  }
}
