export interface CliCommand {
  readonly description: string;
  readonly run: (args: readonly string[]) => Promise<void>;
}

export interface CommandGroup {
  readonly description: string;
  readonly commands: Readonly<Record<string, CliCommand>>;
}
