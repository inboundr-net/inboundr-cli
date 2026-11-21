import { createWriteStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { ListEmailsParams, SendEmailParams, ReplyParams } from "inboundr";
import { intValue, listValue, stringValue, type Command, type Values } from "../command.js";
import { CliError, UsageError } from "../errors.js";
import { readStdin } from "../prompt.js";
import { bold, dim, formatDate, formatList, green, note, print, printJson, table } from "../output.js";

const DIRECTIONS = ["inbound", "outbound"] as const;
const STATUSES = ["delivered", "pending", "failed"] as const;

function oneOf<T extends string>(values: Values, name: string, allowed: readonly T[]): T | undefined {
  const v = stringValue(values, name);
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new UsageError(`--${name} must be one of: ${allowed.join(", ")}.`);
  }
  return v as T;
}

/** --text / --html, or --text-file / --html-file, "-" meaning stdin. */
async function bodies(values: Values): Promise<{ text?: string; html?: string }> {
  let stdinUsed = false;
  const read = async (inline: string, file: string): Promise<string | undefined> => {
    const direct = stringValue(values, inline);
    const path = stringValue(values, file);
    if (direct !== undefined && path !== undefined) {
      throw new UsageError(`Use --${inline} or --${file}, not both.`);
    }
    const source = direct === "-" ? "-" : path;
    if (source === undefined) return direct;
    if (source === "-") {
      if (stdinUsed) throw new UsageError("Only one of the bodies can come from stdin.");
      stdinUsed = true;
      return readStdin();
    }
    try {
      return await readFile(source, "utf8");
    } catch (err) {
      throw new CliError(`Can't read ${source}: ${(err as Error).message}`);
    }
  };
  const text = await read("text", "text-file");
  const html = await read("html", "html-file");
  return { ...(text !== undefined ? { text } : {}), ...(html !== undefined ? { html } : {}) };
}

const BODY_OPTIONS = {
  text: { type: "string" },
  html: { type: "string" },
  "text-file": { type: "string" },
  "html-file": { type: "string" },
} as const;

const BODY_FLAGS: [string, string][] = [
  ["--text <text>", "Plain-text body (- reads stdin)"],
  ["--html <html>", "HTML body (- reads stdin)"],
  ["--text-file <path>", "Read the plain-text body from a file"],
  ["--html-file <path>", "Read the HTML body from a file"],
];

export const emailsList: Command = {
  name: "emails list",
  summary: "List email, newest first",
  usage: "[--direction inbound|outbound] [--to <address>] [--limit <n>]",
  flags: [
    ["--direction <dir>", "inbound or outbound"],
    ["--to <address>", "Sent to this address (To, Cc or envelope)"],
    ["--thread <id>", "In this thread"],
    ["--status <status>", "Delivery status: delivered, pending or failed"],
    ["--limit <n>", "How many, 1–100 (default 20)"],
    ["--cursor <cursor>", "The next page, from a previous list"],
  ],
  options: {
    direction: { type: "string" },
    to: { type: "string" },
    thread: { type: "string" },
    status: { type: "string" },
    limit: { type: "string" },
    cursor: { type: "string" },
  },
  async run(ctx) {
    const v = ctx.values;
    const params: ListEmailsParams = {
      limit: intValue(v, "limit", { min: 1, max: 100 }) ?? 20,
    };
    const direction = oneOf(v, "direction", DIRECTIONS);
    const status = oneOf(v, "status", STATUSES);
    if (direction) params.direction = direction;
    if (status) params.deliveryStatus = status;
    const to = stringValue(v, "to");
    const thread = stringValue(v, "thread");
    const cursor = stringValue(v, "cursor");
    if (to) params.to = to;
    if (thread) params.threadId = thread;
    if (cursor) params.cursor = cursor;

    const page = await (await ctx.client()).emails.list(params);
    if (ctx.json) return printJson(page);
    if (page.data.length === 0) return note("No email.");
    table(page.data, [
      { header: "ID", value: (e) => e.id },
      { header: "RECEIVED", value: (e) => formatDate(e.receivedAt) },
      { header: "", value: (e) => (e.direction === "inbound" ? "in" : "out") },
      { header: "FROM", value: (e) => e.fromAddress ?? "", max: 32 },
      { header: "SUBJECT", value: (e) => e.subject ?? "(no subject)", max: 48 },
      { header: "STATUS", value: (e) => e.deliveryStatus ?? "—" },
    ]);
    if (page.nextCursor) note(dim(`\nMore: inboundr emails list --cursor ${page.nextCursor}`));
  },
};

export const emailsGet: Command = {
  name: "emails get",
  summary: "Show one email",
  usage: "<id> [--html]",
  flags: [["--html", "Print the HTML body instead of the text"]],
  options: { html: { type: "boolean" } },
  args: { min: 1, max: 1, names: "email id" },
  async run(ctx) {
    const email = await (await ctx.client()).emails.get(ctx.args[0]!);
    if (ctx.json) return printJson(email);
    const row = (label: string, value: string) => print(`${dim(label.padEnd(9))}${value}`);
    row("From", email.fromAddress ?? "—");
    row("To", formatList(email.toAddresses));
    if (email.ccAddresses.length > 0) row("Cc", formatList(email.ccAddresses));
    row("Subject", bold(email.subject ?? "(no subject)"));
    row("Date", formatDate(email.receivedAt));
    row("Id", `${email.id}  ${dim(`thread ${email.threadId}`)}`);
    row("Checks", `spam ${email.spamVerdict ?? "—"}, SPF ${email.spfVerdict ?? "—"}, DKIM ${email.dkimVerdict ?? "—"}`);
    email.attachments.forEach((a, i) =>
      row(i === 0 ? "Files" : "", `${i}: ${a.filename ?? "(unnamed)"} ${dim(`(${a.contentType}, ${a.size} bytes)`)}`),
    );
    print();
    const body = ctx.values.html ? email.htmlBody : (email.textBody ?? email.htmlBody);
    print(body?.trimEnd() || dim("(empty body)"));
  },
};

export const emailsSend: Command = {
  name: "emails send",
  summary: "Send an email",
  usage: "--from <address> --to <address> --subject <subject> --text <text>",
  flags: [
    ["--from <address>", "A connected sender or an address on a sending domain"],
    ["--to <address>", "Recipient (repeatable, or comma-separated)"],
    ["--cc <address>", "Cc (repeatable)"],
    ["--reply-to <address>", "Reply-To (repeatable)"],
    ["--subject <subject>", "Subject"],
    ...BODY_FLAGS,
  ],
  examples: [
    'inboundr emails send --from agent@yourdomain.com --to jane@example.com --subject "Hi" --text "Hello"',
    'echo "<p>Hello</p>" | inboundr emails send --from … --to … --subject "Hi" --html -',
  ],
  options: {
    from: { type: "string" },
    to: { type: "string", multiple: true },
    cc: { type: "string", multiple: true },
    "reply-to": { type: "string", multiple: true },
    subject: { type: "string" },
    ...BODY_OPTIONS,
  },
  async run(ctx) {
    const v = ctx.values;
    const from = stringValue(v, "from");
    const to = listValue(v, "to");
    const subject = stringValue(v, "subject");
    if (!from) throw new UsageError("Missing --from <address>.");
    if (!to) throw new UsageError("Missing --to <address>.");
    if (subject === undefined) throw new UsageError("Missing --subject <subject>.");
    const body = await bodies(v);
    if (body.text === undefined && body.html === undefined) {
      throw new UsageError("Missing a body: --text or --html.");
    }
    const cc = listValue(v, "cc");
    const replyTo = listValue(v, "reply-to");
    const params: SendEmailParams = {
      from,
      to,
      subject,
      ...body,
      ...(cc ? { cc } : {}),
      ...(replyTo ? { replyTo } : {}),
    };
    const sent = await (await ctx.client()).emails.send(params);
    if (ctx.json) return printJson(sent);
    note(`${green("Sent")} ${sent.id}`);
  },
};

export const emailsReply: Command = {
  name: "emails reply",
  summary: "Reply to an email, in its thread",
  usage: "<id> --text <text> [--all]",
  flags: [
    ...BODY_FLAGS,
    ["--all", "Reply to everyone on the original"],
    ["--from <address>", "Send from this address instead of the one it was sent to"],
  ],
  options: { ...BODY_OPTIONS, all: { type: "boolean" }, from: { type: "string" } },
  args: { min: 1, max: 1, names: "email id" },
  async run(ctx) {
    const body = await bodies(ctx.values);
    if (body.text === undefined && body.html === undefined) {
      throw new UsageError("Missing a body: --text or --html.");
    }
    const from = stringValue(ctx.values, "from");
    const params: ReplyParams = {
      ...body,
      ...(ctx.values.all ? { replyAll: true } : {}),
      ...(from ? { from } : {}),
    };
    const sent = await (await ctx.client()).emails.reply(ctx.args[0]!, params);
    if (ctx.json) return printJson(sent);
    note(`${green("Sent")} ${sent.id}`);
  },
};

export const emailsRetry: Command = {
  name: "emails retry",
  summary: "Deliver an email to its endpoints again",
  usage: "<id>",
  args: { min: 1, max: 1, names: "email id" },
  async run(ctx) {
    const result = await (await ctx.client()).emails.retry(ctx.args[0]!);
    if (ctx.json) return printJson(result);
    note(`${green("Queued")} ${result.retried} ${result.retried === 1 ? "delivery" : "deliveries"} again.`);
  },
};

/** An attachment's name, made safe to create in the current directory. */
export function safeFilename(name: string, index: number): string {
  // Untrusted: an email's sender chose it. No directories, no dotfiles.
  const cleaned = basename(name.replace(/\\/g, "/"))
    .replace(/[\x00-\x1f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || `attachment-${index}`;
}

export const emailsAttachment: Command = {
  name: "emails attachment",
  summary: "Download an attachment",
  usage: "<id> <index> [--output <path>]",
  flags: [
    ["-o, --output <path>", "Where to save it (default: its filename; - for stdout)"],
    ["--force", "Overwrite the file if it exists"],
  ],
  options: { output: { type: "string", short: "o" }, force: { type: "boolean" } },
  args: { min: 2, max: 2, names: "email id and attachment index" },
  async run(ctx) {
    const [id, rawIndex] = ctx.args as [string, string];
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0) {
      throw new UsageError("The attachment index is a number: 0 for the first.");
    }
    const client = await ctx.client();
    let output = stringValue(ctx.values, "output");
    if (output === undefined) {
      const email = await client.emails.get(id);
      const attachment = email.attachments[index];
      if (!attachment) {
        throw new CliError(`${id} has ${email.attachments.length} attachment(s); there's no index ${index}.`);
      }
      output = safeFilename(attachment.filename ?? "", index);
    }
    const res = await client.emails.downloadAttachment(id, index);
    if (!res.body) throw new CliError("The attachment came back empty.");
    const source = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
    if (output === "-") {
      await pipeline(source, process.stdout);
      return;
    }
    try {
      await pipeline(source, createWriteStream(output, { flags: ctx.values.force ? "w" : "wx" }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new CliError(`${output} already exists. Pass --force to overwrite it, or --output another path.`);
      }
      // Don't leave half a file behind that looks like the whole one.
      await rm(output, { force: true });
      throw err;
    }
    if (ctx.json) return printJson({ path: output });
    note(`${green("Saved")} ${output}`);
  },
};
