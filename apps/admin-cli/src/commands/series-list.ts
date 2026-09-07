import { unavailableCommand } from "../unavailable-command.js";
import type { CliCommand } from "../command-types.js";

export const seriesListCommand: CliCommand = unavailableCommand(
  "List option series."
);
