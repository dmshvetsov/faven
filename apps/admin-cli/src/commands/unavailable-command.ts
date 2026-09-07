import { log } from "@clack/prompts";

import type { CliCommand } from "./types.js";

export function unavailableCommand(description: string): CliCommand {
  return {
    description,
    async run(args) {
      log.warn("This command is not implemented yet.");
      if (args.length > 0) log.info(`Arguments received: ${args.join(" ")}`);
      log.info("No changes were made.");
      return { outcome: "completed" };
    },
  };
}
