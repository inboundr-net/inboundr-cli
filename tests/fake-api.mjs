// A stand-in for the Inboundr API, just enough for the CLI's commands.
import { createServer } from "node:http";

export const API_KEY = "inb_test_key_0123456789";

let counter = 0;
export function makeEmail(overrides = {}) {
  counter++;
  const id = overrides.id ?? `em_${String(counter).padStart(20, "0")}`;
  return {
    id,
    domainId: "dom_1",
    direction: "inbound",
    messageId: `<${id}@example.com>`,
    inReplyTo: null,
    referencesHeader: null,
    threadId: `thr_${id.slice(3)}`,
    fromAddress: "jane@example.com",
    toAddresses: ["support@yourdomain.com"],
    ccAddresses: [],
    replyToAddresses: [],
    senderId: null,
    recipients: ["support@yourdomain.com"],
    subject: `Order ${counter}`,
    textBody: "Where is my order?",
    htmlBody: "<p>Where is my order?</p>",
    attachments: [
      { filename: "invoice.pdf", contentType: "application/pdf", size: 5, stored: true, downloadUrl: `https://inboundr.net/api/v1/emails/${id}/attachments/0/download` },
    ],
    spamVerdict: "PASS",
    spfVerdict: "PASS",
    dkimVerdict: "PASS",
    deliveryStatus: "delivered",
    sendStatus: null,
    receivedAt: new Date(Date.now() + counter).toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const summary = (e) => ({
  id: e.id, direction: e.direction, threadId: e.threadId, messageId: e.messageId,
  fromAddress: e.fromAddress, toAddresses: e.toAddresses, ccAddresses: e.ccAddresses,
  recipients: e.recipients, subject: e.subject, spamVerdict: e.spamVerdict,
  deliveryStatus: e.deliveryStatus, attachmentCount: e.attachments.length, receivedAt: e.receivedAt,
});

export async function startFakeApi() {
  /** Newest first, like the real list. */
  const emails = [];
  const requests = [];
  const sent = [];
  /** Email id → how many more GETs of it should fail with a 500. */
  const failGet = new Map();
  /** Answer the next N list calls with a 429 (Retry-After: 1). */
  const state = { rateLimitLists: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "x-request-id": "req_test" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${API_KEY}`) return json(401, { error: "Invalid API key" });
    let body = "";
    for await (const chunk of req) body += chunk;
    const p = url.pathname.replace(/^\/api\/v1/, "");
    let m;
    if (req.method === "GET" && p === "/emails") {
      if (state.rateLimitLists > 0) {
        state.rateLimitLists--;
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        return res.end(JSON.stringify({ error: "Maximum 5 requests per second allowed." }));
      }
      let list = emails;
      const dir = url.searchParams.get("direction");
      if (dir) list = list.filter((e) => e.direction === dir);
      const to = url.searchParams.get("to");
      if (to) list = list.filter((e) => e.toAddresses.includes(to));
      const limit = Number(url.searchParams.get("limit") || 20);
      const start = Number(url.searchParams.get("cursor") || 0);
      const page = list.slice(start, start + limit);
      return json(200, { data: page.map(summary), nextCursor: start + limit < list.length ? String(start + limit) : null });
    }
    if (req.method === "GET" && (m = p.match(/^\/emails\/([^/]+)$/))) {
      const left = failGet.get(m[1]) ?? 0;
      if (left > 0) {
        failGet.set(m[1], left - 1);
        return json(500, { error: "Internal error" });
      }
      const e = emails.find((x) => x.id === m[1]);
      return e ? json(200, e) : json(404, { error: "Not found" });
    }
    if (req.method === "GET" && (m = p.match(/^\/emails\/([^/]+)\/attachments\/(\d+)$/)) && url.searchParams.get("download") === "1") {
      res.writeHead(200, { "content-type": "application/pdf" });
      return res.end("%PDF-");
    }
    if (req.method === "POST" && (m = p.match(/^\/emails\/([^/]+)\/reply$/))) {
      sent.push({ reply: m[1], ...JSON.parse(body) });
      return json(201, { id: "em_reply", messageId: "<r@x>", threadId: "thr_1" });
    }
    if (req.method === "POST" && p === "/emails") {
      sent.push(JSON.parse(body));
      return json(201, { id: "em_sent", messageId: "<s@x>", threadId: "thr_2" });
    }
    if (req.method === "GET" && (m = p.match(/^\/threads\/([^/]+)$/))) {
      return json(200, { threadId: m[1], data: emails.filter((e) => e.threadId === m[1]).map(summary) });
    }
    if (req.method === "GET" && p === "/domains") {
      return json(200, { data: [{ id: "dom_1", domain: "yourdomain.com", status: "verified", state: "active" }] });
    }
    return json(404, { error: "Not found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    emails,
    requests,
    sent,
    failGet,
    state,
    /** Adds emails as if they just arrived. */
    receive(...items) {
      emails.unshift(...items.reverse());
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
