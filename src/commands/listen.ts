import { InboundrApiError, InboundrRateLimitError, type EmailSummary, type ListEmailsParams } from "inboundr";
import { writeConfig } from "../config.js";
import { describeError, intValue, stringValue, type Command } from "../command.js";
import { anySignal, forward, headerProblem, newWebhookSecret, type ForwardResult } from "../delivery.js";
import { UsageError } from "../errors.js";
import { bold, cyan, dim, formatTime, green, note, print, red, safe, truncate, yellow } from "../output.js";
import { USER_AGENT } from "../version.js";

/** How many ids to remember; far more than can arrive between two polls. */
const SEEN_LIMIT = 5000;
/** Pages to walk in one poll before giving up on catching up. */
const MAX_PAGES = 10;
const PAGE_SIZE = 50;
/** Tries at fetching one email before listen reports it and moves on. */
const MAX_FETCH_ATTEMPTS = 3;

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
    const name = raw.slice(0, i).trim();
    const value = raw.slice(i + 1).trim();
    // Checked here, so a bad one is a usage error now rather than a failed
    // delivery for every email later.
    const problem = headerProblem(name, value);
    if (problem) throw new UsageError(`--header: ${problem}`);
    headers[name] = value;
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

    // Ctrl-C aborts this, which cancels whatever request is in flight —
    // an API call or a forward your server is slow to answer — instead of
    // waiting out its timeout.
    const stop = new AbortController();
    const client = await ctx.client({
      fetch: (input, init) =>
        fetch(input, { ...init, signal: init?.signal ? anySignal([init.signal, stop.signal]) : stop.signal }),
    });
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

    const onSignal = () => stop.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    /** A problem worth telling the user about; a JSON line in --json mode. */
    const warn = (error: string, extra: Record<string, unknown> = {}) => {
      if (ctx.json) print(JSON.stringify({ type: "error", ...extra, error }));
      else note(yellow(error));
    };

    if (!ctx.json) {
      note(`${green("Ready.")} Forwarding new inbound email${to ? ` to ${bold(to)}` : ""} to ${bold(url)}`);
      note(`Webhook secret: ${cyan(secret)} ${dim("(set it as INBOUNDR_WEBHOOK_SECRET in your app)")}`);
      note(dim("Real endpoints keep receiving deliveries as usual. Ctrl-C to stop."));
      note();
    }

    let failures = 0;
    let skipSleep = false;
    const fetchFailures = new Map<string, number>();
    try {
      while (!stop.signal.aborted) {
        if (!skipSleep) {
          await sleep(failures > 0 ? Math.min(intervalMs * 2 ** failures, 60_000) : intervalMs, stop.signal);
        }
        skipSleep = false;
        if (stop.signal.aborted) break;

        let batch: { fresh: EmailSummary[]; complete: boolean };
        try {
          batch = await newEmails(client.emails.list.bind(client.emails), params, seen);
          failures = 0;
        } catch (err) {
          if (stop.signal.aborted) break;
          if (err instanceof InboundrApiError && (err.status === 401 || err.status === 403)) throw err;
          if (err instanceof InboundrRateLimitError && err.retryAfterSeconds) {
            // Wait exactly as long as the API asked, then check straight
            // away: a 429 with an answer isn't a failure to back off from.
            warn(`Rate limited; checking again in ${err.retryAfterSeconds}s.`, { stage: "list" });
            await sleep(err.retryAfterSeconds * 1000, stop.signal);
            skipSleep = true;
            continue;
          }
          failures++;
          warn(`Couldn't check for new email: ${safe(describeError(err))} Retrying.`, { stage: "list" });
          continue;
        }
        if (!batch.complete) {
          warn(
            `More than ${MAX_PAGES * PAGE_SIZE} new emails arrived since the last check. Forwarding the newest ${MAX_PAGES * PAGE_SIZE}; older ones are skipped.`,
            { stage: "list" },
          );
        }

        // Oldest first, the order they arrived in.
        for (const summary of batch.fresh.reverse()) {
          if (stop.signal.aborted) break;
          let email;
          try {
            email = await client.emails.get(summary.id);
          } catch (err) {
            if (stop.signal.aborted) break;
            // Left unseen, so the next check tries it again — a few times.
            const attempts = (fetchFailures.get(summary.id) ?? 0) + 1;
            const giveUp = attempts >= MAX_FETCH_ATTEMPTS;
            if (giveUp) {
              fetchFailures.delete(summary.id);
              remember(summary.id);
            } else {
              fetchFailures.set(summary.id, attempts);
            }
            warn(
              `Couldn't fetch ${summary.id}: ${safe(describeError(err))}${giveUp ? " Skipping it." : " Trying again on the next check."}`,
              { stage: "fetch", emailId: summary.id, gaveUp: giveUp },
            );
            continue;
          }
          fetchFailures.delete(summary.id);
          // Marked before forwarding: a handler that fails is reported, not
          // sent the same email on every poll.
          remember(summary.id);
          const result = await forward(url, email, secret, {
            timeoutMs,
            userAgent: `${USER_AGENT} (listen)`,
            headers,
            signal: stop.signal,
          });
          if (stop.signal.aborted) break;
          if (ctx.json) {
            print(JSON.stringify({ type: "delivery", emailId: email.id, ...result }));
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
 * one it has seen, so a burst larger than a page isn't missed. `complete` is
 * false when it stopped at the page limit with older unseen email left.
 */
export async function newEmails(
  list: (p: ListEmailsParams) => Promise<{ data: EmailSummary[]; nextCursor: string | null }>,
  params: ListEmailsParams,
  seen: Set<string>,
): Promise<{ fresh: EmailSummary[]; complete: boolean }> {
  const fresh: EmailSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await list(cursor ? { ...params, cursor } : params);
    let reachedSeen = false;
    for (const e of res.data) {
      if (seen.has(e.id)) reachedSeen = true;
      else fresh.push(e);
    }
    if (reachedSeen || !res.nextCursor) return { fresh, complete: true };
    cursor = res.nextCursor;
  }
  return { fresh, complete: false };
}
