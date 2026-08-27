import { validate as validateUuid, version as uuidVersion } from "uuid";

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: string;
  readonly params: unknown;
}

export function parseJsonRpcRequest(value: string): JsonRpcRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid JSON-RPC request.");
  }
  if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") {
    throw new Error("Invalid JSON-RPC request.");
  }
  if (
    typeof parsed.id !== "string" ||
    !validateUuid(parsed.id) ||
    uuidVersion(parsed.id) !== 7
  ) {
    throw new Error("Invalid JSON-RPC request.");
  }
  if (typeof parsed.method !== "string") {
    throw new Error("Invalid JSON-RPC request.");
  }
  return {
    jsonrpc: "2.0",
    id: parsed.id,
    method: parsed.method,
    params: parsed.params,
  };
}

export function jsonRpcResult(id: string, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

export function jsonRpcError(
  id: string | null,
  code: number,
  message: string,
  reason: string,
  rfqId?: string
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data: { reason, ...(rfqId === undefined ? {} : { rfqId }) },
    },
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
