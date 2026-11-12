import { DurableObject } from 'cloudflare:workers';
import { ACTIVITY_TTL_MS, type Activity, type LiveState, activityEvent, currentActivity, latestViewer, parseViewerMessage } from './liveState';

/**
 * One object per draft. Open previews hold hibernating WebSockets to it.
 * - The API posts {"type":"changed"} and {"type":"seek"} events, which are relayed to every preview.
 * - Previews report where the creator is looking; each report is kept only on its socket.
 * - Agents set activity, which lapses after three minutes unless renewed; an alarm then deletes it.
 */
export class SceneLive extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const now = Date.now();
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      const activity = currentActivity(await this.ctx.storage.get<Activity>('activity'), now);
      if (activity) pair[1].send(activityEvent(activity, now));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/state') {
      const sockets = this.ctx.getWebSockets();
      const state: LiveState = {
        previews: sockets.length,
        viewer: latestViewer(sockets.map((ws) => ws.deserializeAttachment())),
        activity: currentActivity(await this.ctx.storage.get<Activity>('activity'), now),
      };
      return Response.json(state);
    }
    if (request.method === 'POST' && path === '/activity') {
      const body = (await request.json()) as { state: 'working' | 'idle'; message?: string };
      let activity: Activity | null = null;
      if (body.state === 'working') {
        activity = { message: body.message ?? '', expiresAt: now + ACTIVITY_TTL_MS, updatedAt: now };
        await this.ctx.storage.put('activity', activity);
        await this.ctx.storage.setAlarm(activity.expiresAt);
      } else {
        await this.ctx.storage.delete('activity');
        await this.ctx.storage.deleteAlarm();
      }
      return Response.json({ previews: this.broadcast(activityEvent(activity, now)), activity });
    }
    if (request.method === 'POST') {
      // "changed" and "seek" events from the API are relayed as they are.
      return Response.json({ previews: this.broadcast(await request.text()) });
    }
    return new Response('Not found', { status: 404 });
  }

  /** Expired activity text is deleted rather than kept. */
  override async alarm(): Promise<void> {
    const stored = await this.ctx.storage.get<Activity>('activity');
    if (!stored) return;
    if (currentActivity(stored, Date.now())) await this.ctx.storage.setAlarm(stored.expiresAt);
    else await this.ctx.storage.delete('activity');
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const report = parseViewerMessage(message, Date.now());
    if (report) ws.serializeAttachment(report);
  }

  private broadcast(message: string): number {
    let delivered = 0;
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
        delivered++;
      } catch {
        // A socket closing mid-send is not an error.
      }
    }
    return delivered;
  }
}
