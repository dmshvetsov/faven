export interface CliCommand {
  readonly description: string;
  readonly run: (args: readonly string[]) => Promise<CliCommandResult>;
}

export interface CliCommandResult {
  readonly outcome: "completed" | "cancelled" | "pending" | "failed";
}

export interface CommandGroup {
  readonly description: string;
  readonly commands: Readonly<Record<string, CliCommand>>;
}
