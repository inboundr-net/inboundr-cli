import { InboundrApiError, InboundrRateLimitError, type EmailSummary, type ListEmailsParams } from "inboundr";
import { writeConfig } from "../config.js";
import { describeError, intValue, stringValue, type Command } from "../command.js";
import { forward, newWebhookSecret, type ForwardResult } from "../delivery.js";
import { UsageError } from "../errors.js";
import { bold, cyan, dim, formatTime, green, note, print, red, truncate, yellow } from "../output.js";
import { USER_AGENT } from "../version.js";

/** How many ids to remember; far more than can arrive between two polls. */
const SEEN_LIMIT = 5000;
/** Pages to walk in one poll before giving up on catching up. */
const MAX_PAGES = 10;
const PAGE_SIZE = 50;

function parseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
  } catch {
    throw new UsageError(`--forward-to isn't a URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError("--forward-to must be an http:// or https:// URL.");
  }
  return url;
}

function parseHeaders(values: string[] | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const raw of values ?? []) {
    const i = raw.indexOf(":");
    if (i <= 0) throw new UsageError(`--header must look like "Name: value", got: ${raw}`);
    headers[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
  }
  return headers;
}

/** A sleep that Ctrl-C cuts short. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function describeResult(r: ForwardResult): string {
  if (r.status === null) return `${red("[ERR]")} ${r.error ?? "failed"}`;
  const code = `[${r.status}]`;
  const painted = r.status >= 200 && r.status < 300 ? green(code) : r.status >= 300 && r.status < 400 ? yellow(code) : red(code);
  const tail =
    r.status >= 300 && r.responseBody ? `  ${dim(truncate(r.responseBody, 80))}` : "";
  return `${painted} ${dim(`${r.durationMs} ms`)}${tail}`;
}

export const listen: Command = {
  name: "listen",
  summary: "Forward new inbound email to a local URL, signed like a real delivery",
  usage: "--forward-to <url> [--to <address>] [--interval <seconds>]",
  flags: [
    ["-f, --forward-to <url>", "Where to POST each email, e.g. localhost:3000/inbound"],
    ["--to <address>", "Only email sent to this address"],
    ["--secret <whsec_…>", "Sign with this secret instead of the saved local one"],
    ["--print-secret", "Print the local signing secret and exit"],
    ["--header <name: value>", "Add a header to each request (repeatable)"],
    ["--interval <seconds>", "How often to check for new email (default 2)"],
    ["--timeout <seconds>", "How long to wait for your server (default 30)"],
  ],
  examples: [
    "inboundr listen --forward-to localhost:3000/inbound",
    "inboundr listen -f localhost:8000/inbound --to support@yourdomain.com",
    "export INBOUNDR_WEBHOOK_SECRET=$(inboundr listen --print-secret)",
  ],
  options: {
    "forward-to": { type: "string", short: "f" },
    to: { type: "string" },
    secret: { type: "string" },
    "print-secret": { type: "boolean" },
    header: { type: "string", multiple: true },
    interval: { type: "string" },
    timeout: { type: "string" },
  },
  async run(ctx) {
    const { values } = ctx;

    // The local secret is created once and kept, so the app's .env doesn't
    // change every time listen starts.
    let secret = stringValue(values, "secret");
    if (secret === undefined) {
      const config = await ctx.config();
      secret = config.listenSecret;
      if (!secret) {
        secret = newWebhookSecret();
        await writeConfig({ ...config, listenSecret: secret });
      }
    } else if (!secret) {
      throw new UsageError("--secret can't be empty.");
    }

    if (values["print-secret"]) {
      print(secret);
      return;
    }

    const target = stringValue(values, "forward-to");
    if (!target) throw new UsageError("Missing --forward-to <url>.");
    const url = parseUrl(target).toString();
    // Not listValue: a header value may itself contain commas.
    const headers = parseHeaders(values.header as string[] | undefined);
    const intervalMs = (intValue(values, "interval", { min: 1, max: 60 }) ?? 2) * 1000;
    const timeoutMs = (intValue(values, "timeout", { min: 1, max: 120 }) ?? 30) * 1000;
    const to = stringValue(values, "to");

    const client = await ctx.client();
    const params: ListEmailsParams = { direction: "inbound", limit: PAGE_SIZE, ...(to ? { to } : {}) };

    // Everything already stored counts as seen: listen forwards what arrives
    // from now on, like a real endpoint added today.
    const seen = new Set<string>();
    const remember = (id: string) => {
      seen.add(id);
      if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
    };
    const baseline = await client.emails.list(params);
    for (const e of baseline.data) remember(e.id);

    const stop = new AbortController();
    const onSignal = () => stop.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    if (!ctx.json) {
      note(`${green("Ready.")} Forwarding new inbound email${to ? ` to ${bold(to)}` : ""} to ${bold(url)}`);
      note(`Webhook secret: ${cyan(secret)} ${dim("(set it as INBOUNDR_WEBHOOK_SECRET in your app)")}`);
      note(dim("Real endpoints keep receiving deliveries as usual. Ctrl-C to stop."));
      note();
    }

    let failures = 0;
    try {
      while (!stop.signal.aborted) {
        await sleep(failures > 0 ? Math.min(intervalMs * 2 ** failures, 60_000) : intervalMs, stop.signal);
        if (stop.signal.aborted) break;

        let fresh: EmailSummary[];
        try {
          fresh = await newEmails(client.emails.list.bind(client.emails), params, seen);
          failures = 0;
        } catch (err) {
          if (err instanceof InboundrApiError && (err.status === 401 || err.status === 403)) throw err;
          if (err instanceof InboundrRateLimitError && err.retryAfterSeconds) {
            await sleep(err.retryAfterSeconds * 1000, stop.signal);
          }
          failures++;
          if (!ctx.json) note(yellow(`Couldn't check for new email: ${describeError(err)} Retrying.`));
          continue;
        }

        // Oldest first, the order they arrived in.
        for (const summary of fresh.reverse()) {
          if (stop.signal.aborted) break;
          // Marked before forwarding: a handler that fails is reported, not
          // sent the same email on every poll.
          remember(summary.id);
          let email;
          try {
            email = await client.emails.get(summary.id);
          } catch (err) {
            if (!ctx.json) note(yellow(`Couldn't fetch ${summary.id}: ${describeError(err)}`));
            continue;
          }
          const result = await forward(url, email, secret, {
            timeoutMs,
            userAgent: `${USER_AGENT} (listen)`,
            headers,
          });
          if (ctx.json) {
            print(JSON.stringify({ emailId: email.id, ...result }));
          } else {
            print(
              `${dim(formatTime(new Date()))}  ${email.id}  ${truncate(email.fromAddress ?? "", 32)}  ${truncate(email.subject ?? "(no subject)", 40)}  →  ${describeResult(result)}`,
            );
          }
        }
      }
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    if (!ctx.json) note(dim("Stopped."));
  },
};

/**
 * The inbound emails not seen yet, newest first. Walks pages until it reaches
 * one it has seen, so a burst larger than a page isn't missed.
 */
export async function newEmails(
  list: (p: ListEmailsParams) => Promise<{ data: EmailSummary[]; nextCursor: string | null }>,
  params: ListEmailsParams,
  seen: Set<string>,
): Promise<EmailSummary[]> {
  const fresh: EmailSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await list(cursor ? { ...params, cursor } : params);
    let reachedSeen = false;
    for (const e of res.data) {
      if (seen.has(e.id)) reachedSeen = true;
      else fresh.push(e);
    }
    if (reachedSeen || !res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return fresh;
}
