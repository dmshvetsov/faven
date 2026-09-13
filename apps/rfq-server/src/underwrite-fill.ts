export function isBuyerFaultUnderwriteFailure(
  error: string,
  simulationResult?: unknown
): boolean {
  const details = [error, ...simulationLogs(simulationResult)].join("\n");
  const normalized = details.toLowerCase();

  // A signed buyer transaction becomes unusable when its recent blockhash
  // expires, regardless of which account would otherwise fund it.
  if (
    normalized.includes("blockhashnotfound") ||
    normalized.includes("blockhash not found") ||
    normalized.includes("transactionexpiredblockheightexceeded") ||
    normalized.includes("block height exceeded")
  ) {
    return true;
  }

  const buyerAccountNamed =
    normalized.includes("buyer_quote_source") ||
    normalized.includes("buyer long ata") ||
    normalized.includes("buyer_long_ata") ||
    normalized.includes("buyer ata");
  const buyerAccountFailure =
    normalized.includes("invalidfundingaccount") ||
    normalized.includes('"custom":6014') ||
    normalized.includes("accountnotfound") ||
    normalized.includes("uninitializedaccount") ||
    normalized.includes("invalidaccountdata") ||
    normalized.includes("accountownedbywrongprogram") ||
    normalized.includes("incorrectprogramid") ||
    normalized.includes("accountfrozen");
  if (buyerAccountNamed && buyerAccountFailure) return true;

  // Underwriting transfers seller collateral first. The second and third SPL
  // TransferChecked instructions debit the buyer for premium and fees.
  const buyerPaymentAttempted = transferCheckedCount(simulationResult) >= 2;
  const buyerPaymentFailure =
    normalized.includes("insufficientfunds") ||
    normalized.includes("insufficient funds") ||
    normalized.includes("accountfrozen");
  return buyerPaymentAttempted && buyerPaymentFailure;
}

function simulationLogs(result: unknown): readonly string[] {
  if (!isRecord(result) || !isRecord(result.value)) return [];
  const logs = result.value.logs;
  if (!Array.isArray(logs)) return [];
  return logs.filter((log): log is string => typeof log === "string");
}

function transferCheckedCount(result: unknown): number {
  return simulationLogs(result).filter((log) =>
    log.includes("Instruction: TransferChecked")
  ).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
