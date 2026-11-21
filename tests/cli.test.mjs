import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { verifyWebhookDeliveryPayload } from "inboundr";
import { API_KEY, makeEmail, startFakeApi } from "./fake-api.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;

// Everything a test starts is stopped when the file ends, pass or fail. A
// failed assertion skips a test's own cleanup, and one `listen` left running
// keeps the runner waiting forever: CI would hang instead of failing.
const children = new Set();
const servers = new Set();
function spawn(...args) {
  const child = spawnChild(...args);
  children.add(child);
  child.on("close", () => children.delete(child));
  return child;
}
function createServer(...args) {
  const server = createHttpServer(...args);
  servers.add(server);
  return server;
}
after(() => {
  for (const child of children) child.kill("SIGKILL");
  for (const server of servers) {
    server.closeAllConnections?.();
    server.close(() => {});
  }
});
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

/** Starts `inboundr listen` and returns helpers to wait on and stop it. */
function startListen(args, envExtra) {
  const child = spawn(process.execPath, [CLI, "listen", ...args], { env: env(envExtra) });
  const out = { stdout: "", stderr: "" };
  child.stdout.on("data", (d) => (out.stdout += d));
  child.stderr.on("data", (d) => (out.stderr += d));
  const exited = new Promise((r) => child.on("close", r));
  const until = async (cond, ms = 8000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timed out\nstdout: ${out.stdout}\nstderr: ${out.stderr}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { child, out, exited, until };
}

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

test("escape sequences in an email never reach the terminal", async () => {
  const email = makeEmail({
    fromAddress: "x\x1b]0;window title\x07@example.com",
    subject: "Invoice\x1b]52;c;ZXZpbA==\x07\x1b[2K\x1b[1A",
    textBody: "Hello\x1b[2J\r\nsecond line\u009b31m‮",
    attachments: [{ filename: "a\x1b[31m.pdf", contentType: "application/pdf", size: 1, stored: true, downloadUrl: null }],
  });
  api.receive(email);
  for (const args of [["emails", "list"], ["emails", "get", email.id], ["threads", "get", email.threadId]]) {
    const r = await run(args);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /[\x00-\x08\x0b-\x1f\x7f-\x9f‮]/, `${args.join(" ")} printed a control character`);
  }
  assert.match((await run(["emails", "get", email.id])).stdout, /Hello\[2J\nsecond line31m/);
  // --json stays the API's exact data, escaped by JSON itself.
  const json = JSON.parse((await run(["emails", "get", email.id, "--json"])).stdout);
  assert.equal(json.subject, email.subject);
});

test("listen rejects a --header it can't send, before starting", async () => {
  for (const header of ["Content-Type: text/plain", "x-inboundr-signature: forged", "X Test: a"]) {
    const r = await run(["listen", "-f", "127.0.0.1:9/inbound", "--header", header]);
    assert.equal(r.code, 2, header);
    assert.match(r.stderr, /--header:/);
  }
});

test("status --json exits 1 when the key doesn't work, like status does", async () => {
  const bad = await run(["status", "--json"], { envExtra: { INBOUNDR_API_KEY: "inb_wrong" } });
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  const none = await run(["status", "--json"], { envExtra: { INBOUNDR_API_KEY: "", INBOUNDR_CONFIG_DIR: join(configDir, "none") } });
  assert.equal(none.code, 1);
  const good = await run(["status", "--json"]);
  assert.equal(good.code, 0);
});

test("global flags work before the command too", async () => {
  const r = await run(["--json", "domains", "list"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout)[0].domain, "yourdomain.com");
  const wrong = await run(["--api-key", "inb_wrong", "domains", "list"]);
  assert.match(wrong.stderr, /Invalid API key/);
  const bare = await run(["--json"]);
  assert.equal(bare.code, 0);
  assert.match(bare.stdout, /Usage/);
});

test("login saves the origin it checked the key against, replacing an older one", async () => {
  const dir = join(configDir, "login-origin");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify({ apiKey: "inb_old", baseUrl: "http://127.0.0.1:9" }));
  const r = await run(["login", "--with-token"], { input: API_KEY, envExtra: { INBOUNDR_API_KEY: "", INBOUNDR_CONFIG_DIR: dir } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(await readFile(join(dir, "config.json"), "utf8")).baseUrl, api.url);
});

test("Ctrl-C stops listen at once, even while the server hasn't answered", async () => {
  let arrived = false;
  const hung = createServer(() => {
    arrived = true; // never answers
  });
  await new Promise((r) => hung.listen(0, "127.0.0.1", r));
  const l = startListen(["-f", `127.0.0.1:${hung.address().port}/inbound`, "--interval", "1", "--timeout", "120"], {
    INBOUNDR_CONFIG_DIR: join(configDir, "hung"),
  });
  await l.until(() => l.out.stderr.includes("Ready."));
  api.receive(makeEmail({ subject: "Slow" }));
  await l.until(() => arrived);
  const started = Date.now();
  l.child.kill("SIGINT");
  assert.equal(await l.exited, 0);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.match(l.out.stderr, /Stopped\./);
  hung.closeAllConnections();
  hung.close();
});

test("listen --json reports fetch failures and rate limits, and retries the email", async () => {
  const port = await freePort();
  const got = [];
  const receiver = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    got.push(JSON.parse(body).email.id);
    res.writeHead(204).end();
  });
  await new Promise((r) => receiver.listen(port, "127.0.0.1", r));
  const l = startListen(["-f", `127.0.0.1:${port}/inbound`, "--interval", "1", "--json"], { INBOUNDR_CONFIG_DIR: join(configDir, "flaky") });
  await new Promise((r) => setTimeout(r, 600));

  const email = makeEmail({ subject: "Flaky" });
  api.failGet.set(email.id, 1);
  api.receive(email);
  await l.until(() => got.includes(email.id));

  api.state.rateLimitLists = 1;
  const after = makeEmail({ subject: "After the 429" });
  api.receive(after);
  await l.until(() => got.includes(after.id));

  l.child.kill("SIGINT");
  assert.equal(await l.exited, 0);
  receiver.close();
  const lines = l.out.stdout.trim().split("\n").map((s) => JSON.parse(s));
  const fetchError = lines.find((x) => x.type === "error" && x.stage === "fetch");
  assert.equal(fetchError.emailId, email.id);
  assert.equal(fetchError.gaveUp, false);
  assert.ok(lines.some((x) => x.type === "error" && /Rate limited/.test(x.error)));
  assert.deepEqual(lines.filter((x) => x.type === "delivery").map((x) => x.emailId), [email.id, after.id]);
  assert.equal(got.filter((id) => id === email.id).length, 1, "retried once, delivered once");
});
