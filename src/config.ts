import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "./errors.js";

/**
 * What `inboundr login` and `inboundr listen` remember between runs.
 *
 * A plain JSON file, readable only by you (0600, in a 0700 directory) — the
 * same trade-off as gh's hosts.yml and the Stripe CLI's config.toml. An OS
 * keychain would need a native module, which `npx` can't build everywhere.
 */
export type Config = {
  apiKey?: string;
  baseUrl?: string;
  /** The secret `listen` signs local deliveries with; kept so it's stable. */
  listenSecret?: string;
};

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.INBOUNDR_CONFIG_DIR) return join(env.INBOUNDR_CONFIG_DIR, "config.json");
  if (process.platform === "win32" && env.APPDATA) {
    return join(env.APPDATA, "inboundr", "config.json");
  }
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "inboundr", "config.json");
}

export async function readConfig(path = configPath()): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new CliError(`Can't read ${path}: ${(err as Error).message}`);
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("not a JSON object");
    }
    const { apiKey, baseUrl, listenSecret } = value as Record<string, unknown>;
    return {
      ...(typeof apiKey === "string" ? { apiKey } : {}),
      ...(typeof baseUrl === "string" ? { baseUrl } : {}),
      ...(typeof listenSecret === "string" ? { listenSecret } : {}),
    };
  } catch (err) {
    throw new CliError(
      `${path} isn't valid (${(err as Error).message}). Fix it or delete it and run inboundr login again.`,
    );
  }
}

export async function writeConfig(config: Config, path = configPath()): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Write then rename, so a crash never leaves half a file. The mode on
  // writeFile only applies when the file is created, hence the chmod.
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw new CliError(`Can't write ${path}: ${(err as Error).message}`);
  }
}
