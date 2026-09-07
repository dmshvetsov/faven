import { marketCommands } from "./market.js";
import { seriesCommands } from "./series.js";
import type { CommandGroup } from "./types.js";

export const commandGroups: Readonly<Record<string, CommandGroup>> = {
  series: seriesCommands,
  market: marketCommands,
};

export type { CliCommand, CommandGroup } from "./types.js";
