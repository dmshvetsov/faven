#!/usr/bin/env node

import { intro, log, note, outro } from "@clack/prompts";

import { commandGroups, type CommandGroup } from "./commands/index.js";

const VERSION = "1.0.0";

async function main(args: readonly string[]): Promise<void> {
  const [groupName, commandName, ...commandArgs] = args;

  if (groupName === "--version" || groupName === "-v") {
    console.log(VERSION);
    return;
  }

  if (groupName === undefined || isHelp(groupName)) {
    showMainHelp();
    return;
  }

  const group = commandGroups[groupName];
  if (group === undefined) {
    showError(`Unknown command group: ${groupName}`);
    return;
  }

  if (commandName === undefined || isHelp(commandName)) {
    showGroupHelp(groupName, group);
    return;
  }

  const command = group.commands[commandName];
  if (command === undefined) {
    showError(`Unknown ${groupName} command: ${commandName}`, groupName, group);
    return;
  }

  if (commandArgs.some(isHelp)) {
    showCommandHelp(groupName, commandName, command.description);
    return;
  }

  intro(`faven ${groupName} ${commandName}`);
  await command.run(commandArgs);
  outro("Done.");
}

function isHelp(value: string): boolean {
  return value === "--help" || value === "-h";
}

function showMainHelp(): void {
  intro("faven — Faven administration CLI");
  note(
    [
      "Usage:",
      "  faven <group> <command> [arguments]",
      "",
      "Groups:",
      ...Object.entries(commandGroups).map(
        ([name, group]) => `  ${name.padEnd(8)} ${group.description}`
      ),
      "",
      "Run faven <group> --help to see its commands.",
    ].join("\n"),
    "Commands"
  );
  outro("Ready.");
}

function showGroupHelp(name: string, group: CommandGroup): void {
  intro(`faven ${name}`);
  note(
    [
      `Usage: faven ${name} <command> [arguments]`,
      "",
      "Commands:",
      ...Object.entries(group.commands).map(
        ([commandName, command]) =>
          `  ${commandName.padEnd(10)} ${command.description}`
      ),
    ].join("\n"),
    group.description
  );
  outro("Ready.");
}

function showCommandHelp(
  groupName: string,
  commandName: string,
  description: string
): void {
  intro(`faven ${groupName} ${commandName}`);
  note(
    `Usage: faven ${groupName} ${commandName} [arguments]\n\n${description}`,
    "Command"
  );
  outro("Ready.");
}

function showError(
  message: string,
  groupName?: string,
  group?: CommandGroup
): void {
  intro("faven");
  log.error(message);
  if (groupName !== undefined && group !== undefined) {
    note(`Run faven ${groupName} --help to see its commands.`, "Help");
  } else {
    note("Run faven --help to see available command groups.", "Help");
  }
  outro("No changes were made.");
  process.exitCode = 1;
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  intro("faven");
  log.error(error instanceof Error ? error.message : "Unexpected CLI error.");
  outro("No changes were made.");
  process.exitCode = 1;
});
