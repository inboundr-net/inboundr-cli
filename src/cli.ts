#!/usr/bin/env node
import { describeError, GLOBAL_FLAGS, hoistGlobalFlags, makeContext, parse, type Command } from "./command.js";
import { login, logout, status } from "./commands/auth.js";
import {
  emailsAttachment,
  emailsGet,
  emailsList,
  emailsReply,
  emailsRetry,
  emailsSend,
} from "./commands/emails.js";
import { listen } from "./commands/listen.js";
import {
  addressesList,
  domainsList,
  endpointsDeliveries,
  endpointsList,
  endpointsTest,
  shieldRulesList,
  suppressionsList,
  threadsGet,
} from "./commands/resources.js";
import { CliError, UsageError } from "./errors.js";
import { bold, dim, note, print, red, safe, setColor } from "./output.js";
import { VERSION } from "./version.js";

const COMMANDS: Command[] = [
  listen,
  emailsList,
  emailsGet,
  emailsReply,
  emailsSend,
  emailsRetry,
  emailsAttachment,
  threadsGet,
  domainsList,
  addressesList,
  endpointsList,
  endpointsTest,
  endpointsDeliveries,
  shieldRulesList,
  suppressionsList,
  login,
  logout,
  status,
];

const GROUPS = [...new Set(COMMANDS.filter((c) => c.name.includes(" ")).map((c) => c.name.split(" ")[0]!))];

function flagLines(flags: [string, string][]): string[] {
  const width = Math.max(...flags.map(([f]) => f.length));
  return flags.map(([f, d]) => `  ${f.padEnd(width)}  ${dim(d)}`);
}

function rootHelp(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    `${bold("inboundr")} ${dim(VERSION)} — the Inboundr command line`,
    "",
    `${bold("Usage")}  inboundr <command> [flags]`,
    "",
    bold("Commands"),
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${dim(c.summary)}`),
    "",
    bold("Flags"),
    ...flagLines([...GLOBAL_FLAGS, ["-v, --version", "Print the version"]]),
    "",
    dim("Run inboundr <command> --help for a command's flags. Docs: https://inboundr.net/docs/sdks/cli"),
  ].join("\n");
}

function groupHelp(group: string): string {
  const cmds = COMMANDS.filter((c) => c.name.startsWith(`${group} `));
  const width = Math.max(...cmds.map((c) => c.name.length));
  return [
    `${bold("Usage")}  inboundr ${group} <command> [flags]`,
    "",
    ...cmds.map((c) => `  ${c.name.padEnd(width)}  ${dim(c.summary)}`),
  ].join("\n");
}

function commandHelp(c: Command): string {
  return [
    c.summary,
    "",
    `${bold("Usage")}  inboundr ${c.name}${c.usage ? ` ${c.usage}` : ""}`,
    ...(c.flags?.length ? ["", bold("Flags"), ...flagLines(c.flags)] : []),
    "",
    bold("Global flags"),
    ...flagLines(GLOBAL_FLAGS),
    ...(c.examples?.length ? ["", bold("Examples"), ...c.examples.map((e) => `  ${e}`)] : []),
  ].join("\n");
}

/** Finds the command for argv, accepting "emails list" and a bare "emails". */
function find(argv: string[]): { command?: Command; group?: string; rest: string[] } {
  const [first, second] = argv;
  if (first && GROUPS.includes(first)) {
    const command = second ? COMMANDS.find((c) => c.name === `${first} ${second}`) : undefined;
    return command ? { command, rest: argv.slice(2) } : { group: first, rest: argv.slice(1) };
  }
  const command = COMMANDS.find((c) => c.name === first);
  return { command, rest: argv.slice(1) };
}

export async function main(input: string[]): Promise<number> {
  if (input.includes("--no-color")) setColor(false);
  const { argv, hasCommand } = hoistGlobalFlags(input);
  if (!hasCommand) {
    print(rootHelp());
    return 0;
  }
  const first = argv[0];
  if (first === undefined || first === "help" || first === "--help" || first === "-h") {
    const topic = first === "help" && argv[1] ? find(argv.slice(1)) : undefined;
    print(topic?.command ? commandHelp(topic.command) : topic?.group ? groupHelp(topic.group) : rootHelp());
    return 0;
  }
  if (first === "--version" || first === "-v" || first === "version") {
    print(VERSION);
    return 0;
  }

  const { command, group, rest } = find(argv);
  if (!command) {
    if (group) {
      const sub = rest[0];
      if (sub && sub !== "--help" && sub !== "-h") note(red(`Unknown command: ${group} ${sub}`) + "\n");
      print(groupHelp(group));
      return sub && sub !== "--help" && sub !== "-h" ? 2 : 0;
    }
    note(red(`Unknown command: ${first}`));
    note(dim("Run inboundr --help to see them all."));
    return 2;
  }

  try {
    const { values, args } = parse(command, rest);
    if (values.help) {
      print(commandHelp(command));
      return 0;
    }
    await command.run(makeContext(values, args));
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (err) {
    if (err instanceof UsageError) {
      note(red(err.message));
      note(dim(`Usage: inboundr ${command.name}${command.usage ? ` ${command.usage}` : ""}`));
      note(dim(`Run inboundr ${command.name} --help for more.`));
      return err.exitCode;
    }
    if (err instanceof CliError) {
      if (err.message) note(red(err.message));
      return err.exitCode;
    }
    // API error messages are the server's words; still not ours to trust.
    note(red(safe(describeError(err))));
    return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    note(red(describeError(err)));
    process.exitCode = 1;
  },
);
