/** Formats an unsuccessful `simulateTransaction` response for CLI output. */
export function formatSimulationFailure(response: unknown): string {
  if (
    !isRecord(response) ||
    !isRecord(response.value) ||
    !("err" in response.value)
  ) {
    return "Reason: The RPC returned an invalid simulation response.";
  }
  return [
    `Reason: ${formatSimulationError(response.value.err)}`,
    formatSimulationLogs(response.value.logs),
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function formatSimulationError(error: unknown): string {
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "The RPC returned an unreadable simulation error.";
  }
}

function formatSimulationLogs(logs: unknown): string | undefined {
  if (
    !Array.isArray(logs) ||
    !logs.every((logEntry) => typeof logEntry === "string")
  ) {
    return undefined;
  }
  return `Simulation logs:\n${logs.join("\n")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
