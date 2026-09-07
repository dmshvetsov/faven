import type { CliCommand } from "../command-types.js";
import { unavailableCommand } from "../unavailable-command.js";

export const marketBackfillCommand: CliCommand = unavailableCommand(
  "Backfill market data."
);
