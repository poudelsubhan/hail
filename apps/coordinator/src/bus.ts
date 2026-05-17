import type { WebSocket } from "@fastify/websocket";
import type { WsEvent } from "@ac/contracts";

/**
 * Typed pub/sub for WS events. Two flavors:
 *
 * - Broadcast (`publish`) goes to every subscriber. Dashboard view.
 * - Direct (`pushTo`) targets a specific authenticated user. Used to push
 *   `work.assigned` to a bidder over their authed WS without exposing it on
 *   the anonymous dashboard feed.
 *
 * Sockets that opened with an `?apiKey=` get tagged via `tagSocket`; the user
 * map is the dispatcher for direct push.
 */
class EventBus {
  private subs = new Set<WebSocket>();
  private userSockets = new Map<string, Set<WebSocket>>();

  subscribe(socket: WebSocket) {
    this.subs.add(socket);
    socket.on("close", () => {
      this.subs.delete(socket);
      for (const [uid, set] of this.userSockets) {
        if (set.delete(socket) && set.size === 0) this.userSockets.delete(uid);
      }
    });
  }

  /** Tag an already-subscribed socket with the authenticated user id. */
  tagSocket(socket: WebSocket, userId: string) {
    let set = this.userSockets.get(userId);
    if (!set) {
      set = new Set();
      this.userSockets.set(userId, set);
    }
    set.add(socket);
  }

  publish(evt: WsEvent) {
    const payload = JSON.stringify(evt);
    for (const s of this.subs) {
      if (s.readyState === 1) s.send(payload);
    }
  }

  /** Direct push to one user's socket(s). Returns the number of deliveries. */
  pushTo(userId: string, evt: WsEvent): number {
    const set = this.userSockets.get(userId);
    if (!set) return 0;
    const payload = JSON.stringify(evt);
    let delivered = 0;
    for (const s of set) {
      if (s.readyState === 1) {
        s.send(payload);
        delivered++;
      }
    }
    return delivered;
  }

  size() {
    return this.subs.size;
  }

  userCount() {
    return this.userSockets.size;
  }
}

export const bus = new EventBus();
