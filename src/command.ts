import { parseArgs, type ParseArgsConfig } from "node:util";
import { Inboundr, InboundrApiError, InboundrError, InboundrRateLimitError } from "inboundr";
import { readConfig, type Config } from "./config.js";
import { CliError, UsageError } from "./errors.js";

type Options = NonNullable<ParseArgsConfig["options"]>;

export type Command = {
  /** "emails list", "listen", … */
  name: string;
  summary: string;
  /** Usage lines after the command name, e.g. "<id> [--text <text>]". */
  usage: string;
  /** Flag descriptions for --help, in display order. */
  flags?: [string, string][];
  examples?: string[];
  options?: Options;
  args?: { min: number; max: number; names: string };
  run(ctx: Context): Promise<void>;
};

export type Values = Record<string, string | boolean | string[] | undefined>;

export type Context = {
  values: Values;
  args: string[];
  json: boolean;
  /** The API client, built on first use from flags, env and saved config. */
  client(): Promise<Inboundr>;
  config(): Promise<Config>;
};

/** Flags every command takes. */
export const GLOBAL_OPTIONS: Options = {
  json: { type: "boolean" },
  "api-key": { type: "string" },
  "base-url": { type: "string" },
  "no-color": { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

export const GLOBAL_FLAGS: [string, string][] = [
  ["--json", "Print the API's JSON instead of a table"],
  ["--api-key <key>", "Use this key instead of INBOUNDR_API_KEY or the saved one"],
  ["--base-url <url>", "API origin (default https://inboundr.net)"],
  ["--no-color", "No colour (also NO_COLOR=1)"],
  ["-h, --help", "Show help"],
];

export function parse(command: Command, argv: string[]): { values: Values; args: string[] } {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { ...GLOBAL_OPTIONS, ...command.options },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    // parseArgs' own messages mention internals ("ERR_PARSE_ARGS_…"); keep the
    // first sentence, which names the flag.
    const message = (err as Error).message.split(". To specify")[0] ?? "Invalid arguments";
    throw new UsageError(message);
  }
  const values = parsed.values as Values;
  const args = parsed.positionals;
  if (!values.help && command.args) {
    const { min, max } = command.args;
    if (args.length < min) throw new UsageError(`Missing ${command.args.names}.`);
    if (args.length > max) throw new UsageError(`Unexpected argument: ${args[max]}`);
  } else if (!values.help && !command.args && args.length > 0) {
    throw new UsageError(`Unexpected argument: ${args[0]}`);
  }
  return { values, args };
}

export type KeySource = "flag" | "env" | "config";

export function resolveCredentials(
  values: Values,
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): { apiKey?: string; source?: KeySource; baseUrl?: string } {
  const flag = typeof values["api-key"] === "string" ? values["api-key"] : undefined;
  const fromEnv = env.INBOUNDR_API_KEY || undefined;
  const apiKey = flag ?? fromEnv ?? config.apiKey;
  const source: KeySource | undefined = flag ? "flag" : fromEnv ? "env" : config.apiKey ? "config" : undefined;
  const baseUrl =
    (typeof values["base-url"] === "string" ? values["base-url"] : undefined) ??
    (env.INBOUNDR_BASE_URL || undefined) ??
    config.baseUrl;
  return { apiKey, source, baseUrl: baseUrl?.replace(/\/+$/, "") };
}

export function makeContext(values: Values, args: string[]): Context {
  let config: Promise<Config> | undefined;
  let client: Promise<Inboundr> | undefined;
  const getConfig = () => (config ??= readConfig());
  return {
    values,
    args,
    json: values.json === true,
    config: getConfig,
    client: () =>
      (client ??= getConfig().then((cfg) => {
        const { apiKey, baseUrl } = resolveCredentials(values, cfg);
        if (!apiKey) {
          throw new CliError(
            "No API key. Run inboundr login, or set INBOUNDR_API_KEY.",
          );
        }
        return new Inboundr({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
      })),
  };
}

/** Turns an SDK error into one line a person can act on. */
export function describeError(err: unknown): string {
  if (err instanceof InboundrRateLimitError) {
    return `Rate limited by the API. Try again in ${err.retryAfterSeconds ?? "a few"} seconds.`;
  }
  if (err instanceof InboundrApiError) {
    const hint =
      err.status === 401
        ? " Check your API key, or run inboundr login."
        : err.status === 403 && !/read-only/i.test(err.message)
          ? " This key may be read-only; writes need a full-access key."
          : "";
    const id = err.requestId ? ` (request ${err.requestId})` : "";
    return `${err.message.replace(/\.$/, "")}${id}.${hint}`;
  }
  if (err instanceof InboundrError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function stringValue(values: Values, name: string): string | undefined {
  const v = values[name];
  return typeof v === "string" ? v : undefined;
}

/** A repeatable flag, also accepting comma-separated values. */
export function listValue(values: Values, name: string): string[] | undefined {
  const v = values[name];
  const raw = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  const out = raw.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

export function intValue(values: Values, name: string, range: { min: number; max: number }): number | undefined {
  const v = stringValue(values, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < range.min || n > range.max) {
    throw new UsageError(`--${name} must be a whole number from ${range.min} to ${range.max}.`);
  }
  return n;
}
