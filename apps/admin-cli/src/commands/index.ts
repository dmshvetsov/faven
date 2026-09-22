import type { CommandGroup } from "../command-types.js";
import { marketBackfillCommand } from "./market-backfill.js";
import { createMarketCommand } from "./market-create.js";
import { seriesFinalizeCommand } from "./series-finalize.js";
import { seriesListCommand } from "./series-list.js";
import { seriesSettleCommand } from "./series-settle.js";

export const commandGroups: Readonly<Record<string, CommandGroup>> = {
  series: {
    description: "Manage option series.",
    commands: {
      finalize: seriesFinalizeCommand,
      list: seriesListCommand,
      settle: seriesSettleCommand,
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
