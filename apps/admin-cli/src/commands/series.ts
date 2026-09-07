import { unavailableCommand } from "./unavailable-command.js";
import type { CommandGroup } from "./types.js";

export const seriesCommands: CommandGroup = {
  description: "Manage option series.",
  commands: {
    list: unavailableCommand("List option series."),
  },
};
