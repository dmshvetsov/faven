export class AssetHub implements DurableObject {
  private readonly sockets = new Set<WebSocket>();

  constructor(readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/fanout") {
      return this.fanout(request);
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket endpoint not found.", { status: 404 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.sockets.add(server);
    server.addEventListener("close", () => this.sockets.delete(server));
    server.addEventListener("error", () => this.sockets.delete(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async fanout(request: Request): Promise<Response> {
    const message = await request.text();
    for (const socket of this.sockets) {
      try {
        socket.send(message);
      } catch {
        this.sockets.delete(socket);
      }
    }
    return new Response(null, { status: 204 });
  }
}
