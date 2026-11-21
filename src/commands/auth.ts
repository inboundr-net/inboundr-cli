import { Inboundr } from "inboundr";
import { configPath, readConfig, writeConfig } from "../config.js";
import { describeError, resolveCredentials, stringValue, type Command } from "../command.js";
import { CliError, UsageError } from "../errors.js";
import { readHidden, readStdin } from "../prompt.js";
import { bold, dim, green, note, print, printJson, red } from "../output.js";

/** "inb_AbCd…" — enough to recognise a key, not enough to use it. */
export function maskKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 8)}…` : "inb_…";
}

export const login: Command = {
  name: "login",
  summary: "Save an API key for the commands that follow",
  usage: "[--with-token]",
  flags: [["--with-token", "Read the key from stdin instead of asking"]],
  examples: ["inboundr login", "inboundr login --with-token < key.txt"],
  options: { "with-token": { type: "boolean" } },
  async run(ctx) {
    if (!ctx.values["with-token"]) {
      note(`Create a key in the console under ${bold("API keys")}: https://inboundr.net/console/keys`);
    }
    const key = (
      ctx.values["with-token"] ? await readStdin() : await readHidden("API key: ")
    ).trim();
    if (!key) throw new UsageError("No key given.");
    if (!key.startsWith("inb_")) throw new CliError("That isn't an Inboundr API key; they start with inb_.");

    const config = await readConfig();
    const { baseUrl } = resolveCredentials({ ...ctx.values, "api-key": key }, config);
    try {
      // Any read works for both read-only and full-access keys.
      await new Inboundr({ apiKey: key, ...(baseUrl ? { baseUrl } : {}) }).domains.list();
    } catch (err) {
      throw new CliError(`The key didn't work: ${describeError(err)}`);
    }
    const flagBase = stringValue(ctx.values, "base-url");
    await writeConfig({ ...config, apiKey: key, ...(flagBase ? { baseUrl: flagBase.replace(/\/+$/, "") } : {}) });
    if (ctx.json) return printJson({ saved: configPath(), key: maskKey(key) });
    note(`${green("Logged in")} with ${maskKey(key)}. Saved to ${configPath()}`);
  },
};

export const logout: Command = {
  name: "logout",
  summary: "Forget the saved API key",
  usage: "",
  async run(ctx) {
    const config = await readConfig();
    const had = Boolean(config.apiKey);
    if (had) {
      const { apiKey: _key, baseUrl: _base, ...rest } = config;
      await writeConfig(rest);
    }
    if (ctx.json) return printJson({ removed: had });
    note(had ? "Logged out. The key itself still works until you delete it in the console." : "No saved key.");
    if (process.env.INBOUNDR_API_KEY) note(dim("INBOUNDR_API_KEY is still set in this shell."));
  },
};

export const status: Command = {
  name: "status",
  summary: "Show which API key is in use, and check it works",
  usage: "",
  async run(ctx) {
    const config = await ctx.config();
    const { apiKey, source, baseUrl } = resolveCredentials(ctx.values, config);
    const origin = baseUrl ?? "https://inboundr.net";
    const from = { flag: "--api-key", env: "INBOUNDR_API_KEY", config: configPath() };
    let ok = false;
    let error: string | null = null;
    if (apiKey) {
      try {
        await (await ctx.client()).domains.list();
        ok = true;
      } catch (err) {
        error = describeError(err);
      }
    }
    if (ctx.json) {
      return printJson({ key: apiKey ? maskKey(apiKey) : null, source: source ? from[source] : null, baseUrl: origin, ok, error });
    }
    if (!apiKey) {
      print("Not logged in. Run inboundr login, or set INBOUNDR_API_KEY.");
      throw new CliError("", 1);
    }
    print(`${dim("Key   ")} ${maskKey(apiKey)} ${dim(`from ${from[source!]}`)}`);
    print(`${dim("API   ")} ${origin}`);
    print(`${dim("Check ")} ${ok ? green("works") : red(error ?? "failed")}`);
    if (!ok) throw new CliError("", 1);
  },
};
