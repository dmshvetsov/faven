import { unavailableCommand } from "./unavailable-command.js";
import type { CommandGroup } from "./types.js";

export const marketCommands: CommandGroup = {
  description: "Manage deployed markets.",
  commands: {
    create: unavailableCommand("Create a market."),
    backfill: unavailableCommand("Backfill market data."),
  },
};
