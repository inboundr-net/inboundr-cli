import { intValue, stringValue, type Command } from "../command.js";
import { UsageError } from "../errors.js";
import { dim, formatDate, green, note, print, printJson, red, table, truncate } from "../output.js";

const yesNo = (v: boolean) => (v ? "yes" : "no");

export const threadsGet: Command = {
  name: "threads get",
  summary: "Show every email in a thread, oldest first",
  usage: "<thread-id>",
  args: { min: 1, max: 1, names: "thread id" },
  async run(ctx) {
    const thread = await (await ctx.client()).threads.get(ctx.args[0]!);
    if (ctx.json) return printJson(thread);
    if (thread.data.length === 0) return note("No email in this thread.");
    table(thread.data, [
      { header: "ID", value: (e) => e.id },
      { header: "RECEIVED", value: (e) => formatDate(e.receivedAt) },
      { header: "", value: (e) => (e.direction === "inbound" ? "in" : "out") },
      { header: "FROM", value: (e) => e.fromAddress ?? "", max: 32 },
      { header: "SUBJECT", value: (e) => e.subject ?? "(no subject)", max: 48 },
    ]);
  },
};

export const domainsList: Command = {
  name: "domains list",
  summary: "List your domains",
  usage: "",
  async run(ctx) {
    const { data } = await (await ctx.client()).domains.list();
    if (ctx.json) return printJson(data);
    if (data.length === 0) return note("No domains yet. Add one in the console.");
    table(data, [
      { header: "ID", value: (d) => d.id },
      { header: "DOMAIN", value: (d) => d.domain },
      { header: "STATUS", value: (d) => d.status },
      { header: "STATE", value: (d) => d.state },
    ]);
  },
};

export const addressesList: Command = {
  name: "addresses list",
  summary: "List your addresses and the endpoints they route to",
  usage: "",
  async run(ctx) {
    const { data } = await (await ctx.client()).addresses.list();
    if (ctx.json) return printJson(data);
    if (data.length === 0) return note("No addresses yet.");
    table(data, [
      { header: "ID", value: (a) => a.id },
      { header: "ADDRESS", value: (a) => a.address },
      { header: "ACTIVE", value: (a) => yesNo(a.active) },
      { header: "ENDPOINTS", value: (a) => (a.endpointIds.length ? a.endpointIds.join(", ") : "—"), max: 60 },
    ]);
  },
};

export const endpointsList: Command = {
  name: "endpoints list",
  summary: "List your endpoints",
  usage: "",
  async run(ctx) {
    const { data } = await (await ctx.client()).endpoints.list();
    if (ctx.json) return printJson(data);
    if (data.length === 0) return note("No endpoints yet.");
    table(data, [
      { header: "ID", value: (e) => e.id },
      { header: "NAME", value: (e) => e.name, max: 24 },
      { header: "TYPE", value: (e) => e.type },
      { header: "TARGET", value: (e) => e.url ?? (e.forwardTo?.length ? e.forwardTo.join(", ") : "—"), max: 56 },
      { header: "ACTIVE", value: (e) => yesNo(e.active) },
    ]);
  },
};

export const endpointsTest: Command = {
  name: "endpoints test",
  summary: "Send a sample delivery to an endpoint and show what it answered",
  usage: "<endpoint-id>",
  args: { min: 1, max: 1, names: "endpoint id" },
  async run(ctx) {
    const result = await (await ctx.client()).endpoints.test(ctx.args[0]!);
    if (ctx.json) return printJson(result);
    const code = result.status === null ? "no response" : String(result.status);
    print(`${result.ok ? green("OK") : red("Failed")}  ${code}  ${dim(`${result.durationMs} ms`)}`);
    if (result.error) print(result.error);
    if (result.responseBody) print(dim(truncate(result.responseBody, 400)));
    if (!result.ok) process.exitCode = 1;
  },
};

const DELIVERY_STATUSES = ["pending", "success", "failed", "dead"] as const;

export const endpointsDeliveries: Command = {
  name: "endpoints deliveries",
  summary: "Recent deliveries to an endpoint, with your server's answers",
  usage: "<endpoint-id> [--status failed] [--email <id>] [--limit <n>]",
  flags: [
    ["--status <status>", "pending, success, failed or dead"],
    ["--email <id>", "Only deliveries of this email"],
    ["--limit <n>", "How many, 1–100 (default 20)"],
    ["--cursor <cursor>", "The next page, from a previous list"],
  ],
  options: {
    status: { type: "string" },
    email: { type: "string" },
    limit: { type: "string" },
    cursor: { type: "string" },
  },
  args: { min: 1, max: 1, names: "endpoint id" },
  async run(ctx) {
    const v = ctx.values;
    const status = stringValue(v, "status");
    if (status !== undefined && !(DELIVERY_STATUSES as readonly string[]).includes(status)) {
      throw new UsageError(`--status must be one of: ${DELIVERY_STATUSES.join(", ")}.`);
    }
    const email = stringValue(v, "email");
    const cursor = stringValue(v, "cursor");
    const page = await (await ctx.client()).endpoints.deliveries(ctx.args[0]!, {
      limit: intValue(v, "limit", { min: 1, max: 100 }) ?? 20,
      ...(status ? { status: status as (typeof DELIVERY_STATUSES)[number] } : {}),
      ...(email ? { emailId: email } : {}),
      ...(cursor ? { cursor } : {}),
    });
    if (ctx.json) return printJson(page);
    if (page.data.length === 0) return note("No deliveries.");
    table(page.data, [
      { header: "ID", value: (d) => d.id },
      { header: "EMAIL", value: (d) => d.emailId },
      { header: "WHEN", value: (d) => formatDate(d.lastAttemptAt ?? d.createdAt) },
      { header: "STATUS", value: (d) => (d.status === "success" ? green(d.status) : d.status === "pending" ? d.status : red(d.status)) },
      { header: "TRIES", value: (d) => String(d.attempts) },
      { header: "ANSWER", value: (d) => (d.responseStatus !== null ? String(d.responseStatus) : d.error ?? "—"), max: 48 },
    ]);
    if (page.nextCursor) note(dim(`\nMore: --cursor ${page.nextCursor}`));
  },
};

export const shieldRulesList: Command = {
  name: "shield-rules list",
  summary: "List your Shield rules, in the order they run",
  usage: "",
  async run(ctx) {
    const { data } = await (await ctx.client()).shieldRules.list();
    if (ctx.json) return printJson(data);
    if (data.length === 0) return note("No Shield rules.");
    table(data, [
      { header: "ID", value: (r) => r.id },
      { header: "NAME", value: (r) => r.name, max: 32 },
      { header: "ACTION", value: (r) => r.action },
      { header: "SCOPE", value: (r) => r.scope },
      { header: "ON", value: (r) => yesNo(r.enabled) },
    ]);
  },
};

export const suppressionsList: Command = {
  name: "suppressions list",
  summary: "Addresses sending won't deliver to",
  usage: "",
  async run(ctx) {
    const { data } = await (await ctx.client()).suppressions.list();
    if (ctx.json) return printJson(data);
    if (data.length === 0) return note("No suppressed addresses.");
    table(data, [
      { header: "ADDRESS", value: (s) => s.address },
      { header: "REASON", value: (s) => s.reason },
      { header: "SINCE", value: (s) => formatDate(s.createdAt) },
    ]);
  },
};
