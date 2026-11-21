import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { verifyWebhookDeliveryPayload } from "inboundr";
import { API_KEY, makeEmail, startFakeApi } from "./fake-api.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
let api;
let configDir;

before(async () => {
  api = await startFakeApi();
  configDir = await mkdtemp(join(tmpdir(), "inboundr-cli-"));
});
after(async () => {
  await api.close();
  await rm(configDir, { recursive: true, force: true });
});

function env(extra = {}) {
  return {
    PATH: process.env.PATH,
    INBOUNDR_BASE_URL: api.url,
    INBOUNDR_CONFIG_DIR: configDir,
    INBOUNDR_API_KEY: API_KEY,
    NO_COLOR: "1",
    ...extra,
  };
}

/** Runs the CLI to completion. */
function run(args, { input, envExtra } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: env(envExtra) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

test("help and version", async () => {
  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /listen +Forward new inbound email/);
  const version = await run(["--version"]);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
  const sub = await run(["emails", "reply", "--help"]);
  assert.equal(sub.code, 0);
  assert.match(sub.stdout, /--all/);
});

test("usage mistakes exit 2 with a hint", async () => {
  const unknown = await run(["nope"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown command: nope/);
  const missing = await run(["emails", "get"]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Missing email id/);
  const badFlag = await run(["emails", "list", "--bogus"]);
  assert.equal(badFlag.code, 2);
  assert.match(badFlag.stderr, /bogus/);
  const badLimit = await run(["emails", "list", "--limit", "500"]);
  assert.equal(badLimit.code, 2);
});

test("no key says how to get one", async () => {
  const r = await run(["emails", "list"], { envExtra: { INBOUNDR_API_KEY: "", INBOUNDR_CONFIG_DIR: join(configDir, "empty") } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /inboundr login/);
});

test("an API error is one readable line", async () => {
  const r = await run(["emails", "get", "em_missing"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Not found \(request req_test\)\./);
  const unauthorized = await run(["domains", "list"], { envExtra: { INBOUNDR_API_KEY: "inb_wrong" } });
  assert.match(unauthorized.stderr, /Invalid API key.*inboundr login/);
});

test("emails list, get and --json", async () => {
  const email = makeEmail({ subject: "Refund please" });
  api.receive(email);
  const list = await run(["emails", "list"]);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /ID +RECEIVED/);
  assert.match(list.stdout, new RegExp(`${email.id}.*Refund please`));
  const json = JSON.parse((await run(["emails", "list", "--json"])).stdout);
  assert.ok(json.data.some((e) => e.id === email.id));
  const got = await run(["emails", "get", email.id]);
  assert.match(got.stdout, /Subject  Refund please/);
  assert.match(got.stdout, /Where is my order\?/);
  assert.match(got.stdout, /0: invoice\.pdf/);
});

test("emails reply and send post the right bodies", async () => {
  const reply = await run(["emails", "reply", "em_1", "--text", "On its way", "--all"]);
  assert.equal(reply.code, 0, reply.stderr);
  assert.deepEqual(api.sent.at(-1), { reply: "em_1", text: "On its way", replyAll: true });

  const send = await run(
    ["emails", "send", "--from", "a@yourdomain.com", "--to", "b@example.com,c@example.com", "--subject", "Hi", "--html", "-"],
    { input: "<p>Hello</p>" },
  );
  assert.equal(send.code, 0, send.stderr);
  assert.deepEqual(api.sent.at(-1), { from: "a@yourdomain.com", to: ["b@example.com", "c@example.com"], subject: "Hi", html: "<p>Hello</p>" });

  const noBody = await run(["emails", "send", "--from", "a@x.com", "--to", "b@x.com", "--subject", "Hi"]);
  assert.equal(noBody.code, 2);
});

test("login validates the key and saves it privately; status and logout use it", async () => {
  const dir = join(configDir, "login");
  const bad = await run(["login", "--with-token"], { input: "inb_wrong\n", envExtra: { INBOUNDR_API_KEY: "", INBOUNDR_CONFIG_DIR: dir } });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /didn't work/);

  const ok = await run(["login", "--with-token"], { input: `${API_KEY}\n`, envExtra: { INBOUNDR_API_KEY: "", INBOUNDR_CONFIG_DIR: dir } });
  assert.equal(ok.code, 0, ok.stderr);
  assert.doesNotMatch(ok.stderr + ok.stdout, new RegExp(API_KEY), "the key is never printed in full");
  const file = join(dir, "config.json");
  assert.equal(JSON.parse(await readFile(file, "utf8")).apiKey, API_KEY);
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);

  const status = await run(["status"], { envExtra: { INBOUNDR_API_KEY: "", INBOUNDR_CONFIG_DIR: dir } });
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /inb_test…/);
  assert.match(status.stdout, /works/);

  await run(["logout"], { envExtra: { INBOUNDR_CONFIG_DIR: dir } });
  assert.equal(JSON.parse(await readFile(file, "utf8")).apiKey, undefined);
});

test("emails attachment saves under a safe name and won't overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inboundr-att-"));
  const email = makeEmail({
    attachments: [{ filename: "../../etc/.passwd", contentType: "text/plain", size: 5, stored: true, downloadUrl: null }],
  });
  api.receive(email);
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "emails", "attachment", email.id, "0"], { env: env(), cwd: dir });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(await readFile(join(dir, "passwd"), "utf8"), "%PDF-");
  const again = await run(["emails", "attachment", email.id, "0", "-o", join(dir, "passwd")]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already exists/);
  await rm(dir, { recursive: true, force: true });
});

test("listen forwards only new inbound email, oldest first, verifiable with the SDK", async () => {
  const dir = join(configDir, "listen");
  const secret = (await run(["listen", "--print-secret"], { envExtra: { INBOUNDR_CONFIG_DIR: dir } })).stdout.trim();
  assert.match(secret, /^whsec_/);
  // Stable: the app's .env shouldn't need changing on every run.
  assert.equal((await run(["listen", "--print-secret"], { envExtra: { INBOUNDR_CONFIG_DIR: dir } })).stdout.trim(), secret);

  const received = [];
  const receiver = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const { event, deliveryId } = await verifyWebhookDeliveryPayload(body, req.headers, secret);
      received.push({ id: event.email.id, deliveryId, path: req.url, extra: req.headers["x-test"] });
      res.writeHead(event.email.subject === "Breaks" ? 500 : 204);
      res.end(event.email.subject === "Breaks" ? "boom" : "");
    } catch (err) {
      received.push({ error: err.reason });
      res.writeHead(400).end();
    }
  });
  await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
  const target = `127.0.0.1:${receiver.address().port}/inbound`;

  const old = makeEmail({ subject: "Already here" });
  api.receive(old);

  const child = spawn(process.execPath, [CLI, "listen", "-f", target, "--interval", "1", "--header", "X-Test: a, b"], {
    env: env({ INBOUNDR_CONFIG_DIR: dir }),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((r) => child.on("close", r));
  const until = async (cond, ms = 8000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timed out\nstdout: ${stdout}\nstderr: ${stderr}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  await until(() => stderr.includes("Ready."));
  assert.match(stderr, new RegExp(secret));

  const a = makeEmail({ subject: "First" });
  const b = makeEmail({ subject: "Breaks" });
  const outbound = makeEmail({ subject: "Ours", direction: "outbound" });
  api.receive(a, b, outbound);
  await until(() => received.length >= 2);
  await new Promise((r) => setTimeout(r, 1500)); // one more poll: nothing is sent twice

  child.kill("SIGINT");
  const code = await exited;
  receiver.close();

  assert.equal(code, 0, stderr);
  assert.match(stderr, /Stopped\./);
  assert.deepEqual(received.map((r) => r.id), [a.id, b.id], "new inbound only, oldest first, once each");
  assert.ok(received.every((r) => r.path === "/inbound" && r.extra === "a, b"));
  assert.notEqual(received[0].deliveryId, received[1].deliveryId);
  assert.match(stdout, new RegExp(`${a.id}.*First.*\\[204\\]`));
  assert.match(stdout, new RegExp(`${b.id}.*Breaks.*\\[500\\].*boom`));
});

test("listen reports a server that isn't running and keeps going", async () => {
  const dir = join(configDir, "listen2");
  // A port that was free a moment ago, so nothing is listening on it.
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const child = spawn(process.execPath, [CLI, "listen", "-f", `127.0.0.1:${port}/inbound`, "--interval", "1", "--json"], {
    env: env({ INBOUNDR_CONFIG_DIR: dir }),
  });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  const exited = new Promise((r) => child.on("close", r));
  await new Promise((r) => setTimeout(r, 700));
  const email = makeEmail({ subject: "Nobody home" });
  api.receive(email);
  const end = Date.now() + 8000;
  while (!stdout.includes(email.id) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  child.kill("SIGINT");
  assert.equal(await exited, 0);
  const line = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(line.emailId, email.id);
  assert.equal(line.status, null);
  assert.match(line.error, /connection refused/);
});
