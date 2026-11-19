// Durable Objects of the game server (architecture §4). For now they only accept the
// WebSocket with the hibernation API; AUTH and the room logic arrive with SRV-03 and later.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";

/** Accepts an incoming WebSocket with the hibernation API (the object may sleep between messages). */
function acceptWebSocket(ctx: DurableObjectState): Response {
  const pair = new WebSocketPair();
  ctx.acceptWebSocket(pair[1]);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

/** Common base: accepts WebSockets and completes the closing handshake. */
abstract class WebSocketObject extends DurableObject<Env> {
  override fetch(): Response {
    return acceptWebSocket(this.ctx);
  }

  override webSocketMessage(): void {
    // Messages are handled from SRV-03 on (AUTH, then the room protocol).
  }

  override webSocketClose(ws: WebSocket): void {
    // Answer the client's close frame (codes such as 1005/1006 cannot be echoed).
    ws.close();
  }
}

/** One object per room: waiting room and game. */
export class RoomDO extends WebSocketObject {}

/** One object per player: presence and current room. */
export class UserDO extends WebSocketObject {}

/** Single object: list of public rooms and quick play. */
export class LobbyDO extends WebSocketObject {}
