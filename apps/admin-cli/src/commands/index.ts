import type { CommandGroup } from "../command-types.js";
import { marketBackfillCommand } from "./market-backfill.js";
import { createMarketCommand } from "./market-create.js";
import { seriesListCommand } from "./series-list.js";

export const commandGroups: Readonly<Record<string, CommandGroup>> = {
  series: {
    description: "Manage option series.",
    commands: {
      list: seriesListCommand,
    },
  },
  market: {
    description: "Manage deployed markets.",
    commands: {
      create: createMarketCommand,
      backfill: marketBackfillCommand,
    },
  },
};

export type { CliCommand, CommandGroup } from "../command-types.js";
