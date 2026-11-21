import { readFileSync } from "node:fs";

/** From package.json, one directory above dist/ (and above src/ in tests). */
export const VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

export const USER_AGENT = `inboundr-cli/${VERSION}`;
