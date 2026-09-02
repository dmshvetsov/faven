import { isRecord, jsonRpcError, parseJsonRpcRequest } from "./rfq-rpc";
import type { Env } from "./worker";

type Role = "maker" | "taker";

export class ConnectionHub implements DurableObject {
  private readonly sockets = new Map<string, WebSocket>();
  private readonly sellerRfqs = new Map<string, Set<string>>();

  constructor(
    readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (
      request.method === "POST" &&
      new URL(request.url).pathname === "/notify"
    ) {
      return this.notify(request);
    }
    const role = roleFor(new URL(request.url).pathname);
    if (role === null || request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket endpoint not found.", { status: 404 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const connectionId = crypto.randomUUID();
    this.sockets.set(connectionId, server);
    server.addEventListener("message", (event) => {
      void this.handleMessage(server, role, connectionId, event.data);
    });
    server.addEventListener("close", () => this.removeConnection(connectionId));
    server.addEventListener("error", () => this.removeConnection(connectionId));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async notify(request: Request): Promise<Response> {
    const body: unknown = await request.json();
    if (!isNotification(body))
      return new Response("Invalid notification.", { status: 400 });
    const socket = this.sockets.get(body.connectionId);
    if (socket === undefined) return new Response(null, { status: 204 });
    try {
      socket.send(body.message);
    } catch {
      this.sockets.delete(body.connectionId);
    }
    return new Response(null, { status: 204 });
  }

  private async handleMessage(
    socket: WebSocket,
    role: Role,
    connectionId: string,
    data: unknown
  ): Promise<void> {
    let requestId: string | null = null;
    try {
      const request = parseJsonRpcRequest(await messageText(data));
      requestId = request.id;
      if (role === "taker" && request.method === "rfq.create") {
        await this.createRfq(socket, connectionId, request.id, request.params);
        return;
      }
      if (role === "maker" && request.method === "underwriteTx.generate") {
        await this.generateUnderwrite(socket, request.id, request.params);
        return;
      }
      if (role === "maker" && request.method === "quote.submit") {
        await this.submitQuote(
          socket,
          connectionId,
          request.id,
          request.params
        );
        return;
      }
      if (role === "taker" && request.method === "underwrite.submit") {
        await this.submitUnderwrite(
          socket,
          connectionId,
          request.id,
          request.params
        );
        return;
      }
      {
        socket.send(
          jsonRpcError(requestId, -32601, "Unknown method.", "unknown-method")
        );
      }
    } catch (error) {
      socket.send(
        jsonRpcError(
          requestId,
          1002,
          "RFQ request was rejected.",
          error instanceof Error ? error.message : "invalid-request"
        )
      );
    }
  }

  private async createRfq(
    socket: WebSocket,
    connectionId: string,
    requestId: string,
    params: unknown
  ): Promise<void> {
    const rfqId = rfqIdFrom(params);
    const response = await this.env.RFQ_OBJECT.get(
      this.env.RFQ_OBJECT.idFromName(rfqId)
    ).fetch(
      new Request("https://rfq/create", {
        method: "POST",
        body: JSON.stringify({
          requestId,
          sellerConnectionId: connectionId,
          params,
        }),
      })
    );
    const result = await responseMessage(response);
    if (isSuccessfulResponse(result)) {
      const rfqs = this.sellerRfqs.get(connectionId) ?? new Set<string>();
      rfqs.add(rfqId);
      this.sellerRfqs.set(connectionId, rfqs);
    }
    socket.send(result);
  }

  private async generateUnderwrite(
    socket: WebSocket,
    requestId: string,
    params: unknown
  ): Promise<void> {
    const rfqId = rfqIdFrom(params);
    const response = await this.env.RFQ_OBJECT.get(
      this.env.RFQ_OBJECT.idFromName(rfqId)
    ).fetch(
      new Request("https://rfq/generate", {
        method: "POST",
        body: JSON.stringify({ requestId, params }),
      })
    );
    socket.send(await responseMessage(response));
  }

  private async submitQuote(
    socket: WebSocket,
    connectionId: string,
    requestId: string,
    params: unknown
  ): Promise<void> {
    const rfqId = rfqIdFrom(params);
    const response = await this.env.RFQ_OBJECT.get(
      this.env.RFQ_OBJECT.idFromName(rfqId)
    ).fetch(
      new Request("https://rfq/quote", {
        method: "POST",
        body: JSON.stringify({ requestId, connectionId, params }),
      })
    );
    socket.send(await responseMessage(response));
  }

  private async submitUnderwrite(
    socket: WebSocket,
    connectionId: string,
    requestId: string,
    params: unknown
  ): Promise<void> {
    const rfqId = rfqIdFrom(params);
    const response = await this.env.RFQ_OBJECT.get(
      this.env.RFQ_OBJECT.idFromName(rfqId)
    ).fetch(
      new Request("https://rfq/underwrite", {
        method: "POST",
        body: JSON.stringify({ requestId, connectionId, params }),
      })
    );
    socket.send(await responseMessage(response));
  }

  private removeConnection(connectionId: string): void {
    this.sockets.delete(connectionId);
    const rfqIds = this.sellerRfqs.get(connectionId);
    this.sellerRfqs.delete(connectionId);
    if (rfqIds === undefined) return;
    this.state.waitUntil(this.cancelRfqs(connectionId, rfqIds));
  }

  private async cancelRfqs(
    connectionId: string,
    rfqIds: ReadonlySet<string>
  ): Promise<void> {
    await Promise.all(
      Array.from(rfqIds, (rfqId) =>
        this.env.RFQ_OBJECT.get(this.env.RFQ_OBJECT.idFromName(rfqId)).fetch(
          new Request("https://rfq/cancel", {
            method: "POST",
            body: JSON.stringify({ connectionId }),
          })
        )
      )
    );
  }
}

function roleFor(pathname: string): Role | null {
  if (pathname === "/maker") return "maker";
  if (pathname === "/taker") return "taker";
  return null;
}

function rfqIdFrom(params: unknown): string {
  if (
    typeof params !== "object" ||
    params === null ||
    typeof (params as { rfqId?: unknown }).rfqId !== "string"
  ) {
    throw new Error("invalid-rfq-id");
  }
  return (params as { readonly rfqId: string }).rfqId;
}

async function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data instanceof Blob) return data.text();
  throw new Error("WebSocket message must be text.");
}

async function responseMessage(response: Response): Promise<string> {
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.message !== "string") {
    throw new Error("invalid-rfq-response");
  }
  return body.message;
}

function isSuccessfulResponse(message: string): boolean {
  try {
    const parsed: unknown = JSON.parse(message);
    return isRecord(parsed) && "result" in parsed;
  } catch {
    return false;
  }
}

function isNotification(
  value: unknown
): value is { readonly connectionId: string; readonly message: string } {
  if (!isRecord(value)) return false;
  return (
    typeof value.connectionId === "string" && typeof value.message === "string"
  );
}
