import assert from "node:assert/strict";
import { test } from "node:test";
import { newEmails } from "../dist/commands/listen.js";
import { safeFilename } from "../dist/commands/emails.js";
import { hoistGlobalFlags, resolveCredentials } from "../dist/command.js";
import { loginBaseUrl } from "../dist/commands/auth.js";
import { headerProblem } from "../dist/delivery.js";
import { safe, safeBlock, truncate } from "../dist/output.js";

test("newEmails walks pages until it reaches a seen email", async () => {
  const all = Array.from({ length: 120 }, (_, i) => ({ id: `em_${i}` })); // newest first
  const seen = new Set(["em_110", "em_111"]);
  const calls = [];
  const list = async (p) => {
    calls.push(p.cursor ?? null);
    const start = Number(p.cursor ?? 0);
    return { data: all.slice(start, start + 50), nextCursor: start + 50 < all.length ? String(start + 50) : null };
  };
  const { fresh, complete } = await newEmails(list, { limit: 50 }, seen);
  assert.equal(fresh.length, 118);
  assert.equal(complete, true);
  assert.deepEqual(calls, [null, "50", "100"]);
});

test("newEmails says when a burst is bigger than it will walk", async () => {
  const all = Array.from({ length: 700 }, (_, i) => ({ id: `em_${i}` }));
  const list = async (p) => {
    const start = Number(p.cursor ?? 0);
    return { data: all.slice(start, start + 50), nextCursor: start + 50 < all.length ? String(start + 50) : null };
  };
  const { fresh, complete } = await newEmails(list, { limit: 50 }, new Set(["em_650"]));
  assert.equal(fresh.length, 500);
  assert.equal(complete, false);
});

test("safe() removes what a terminal would act on, and keeps the text", () => {
  assert.equal(safe("Hi \x1b]0;pwned\x07there"), "Hi ]0;pwnedthere");
  assert.equal(safe("\x1b]52;c;ZXZpbA==\x07Invoice"), "]52;c;ZXZpbA==Invoice");
  assert.equal(safe("a\x1b[2K\x1b[1Ab"), "a[2K[1Ab");
  assert.equal(safe("8-bit CSI \u009b31m"), "8-bit CSI 31m");
  assert.equal(safe("evil\u202eexe.pdf"), "evilexe.pdf");
  assert.equal(safe("line\r\nbreak\tand tab"), "line break and tab");
  assert.equal(safe("Où est ma commande ? ✓ 日本"), "Où est ma commande ? ✓ 日本");
  assert.equal(truncate("x\x1b[31m".repeat(3), 80), "x[31mx[31mx[31m");
  assert.equal(safeBlock("Hi,\r\nline two\rthree\n\tindented\x1b[2K"), "Hi,\nline two\nthree\n\tindented[2K");
});

test("headerProblem rejects reserved, malformed and unsafe headers", () => {
  assert.equal(headerProblem("Authorization", "Bearer abc"), null);
  assert.match(headerProblem("Content-Type", "text/plain"), /can't be overridden/);
  assert.match(headerProblem("X-INBOUNDR-SIGNATURE", "x"), /can't be overridden/);
  assert.match(headerProblem("x-inbound-delivery-id", "x"), /can't be overridden/);
  assert.match(headerProblem("X Test", "a"), /valid header name/);
  assert.match(headerProblem("X-Test", "a\nInjected: b"), /characters/);
});

test("global flags before the command move after it", () => {
  assert.deepEqual(hoistGlobalFlags(["--json", "emails", "list"]), { argv: ["emails", "list", "--json"], hasCommand: true });
  assert.deepEqual(hoistGlobalFlags(["--api-key", "inb_x", "--base-url=http://h", "status"]).argv, ["status", "--api-key", "inb_x", "--base-url=http://h"]);
  assert.deepEqual(hoistGlobalFlags(["--json"]), { argv: ["--json"], hasCommand: false });
  assert.deepEqual(hoistGlobalFlags(["emails", "list", "--json"]).argv, ["emails", "list", "--json"]);
});

test("login checks the key against the flag, then the environment, never the old saved origin", () => {
  assert.equal(loginBaseUrl({}, {}), undefined);
  assert.equal(loginBaseUrl({}, { INBOUNDR_BASE_URL: "https://staging.example/" }), "https://staging.example");
  assert.equal(loginBaseUrl({ "base-url": "http://localhost:3000" }, { INBOUNDR_BASE_URL: "https://staging.example" }), "http://localhost:3000");
});

test("safeFilename keeps a plain name and defuses the rest", () => {
  assert.equal(safeFilename("invoice.pdf", 0), "invoice.pdf");
  assert.equal(safeFilename("../../etc/passwd", 0), "passwd");
  assert.equal(safeFilename("..\\..\\boot.ini", 0), "boot.ini");
  assert.equal(safeFilename(".bashrc", 0), "bashrc");
  assert.equal(safeFilename("a\u0000b.txt", 0), "a_b.txt");
  assert.equal(safeFilename("", 3), "attachment-3");
  assert.equal(safeFilename("..", 1), "attachment-1");
});

test("the key comes from the flag, then the environment, then the saved config", () => {
  const config = { apiKey: "inb_saved", baseUrl: "https://saved.example/" };
  assert.deepEqual(resolveCredentials({}, config, {}), { apiKey: "inb_saved", source: "config", baseUrl: "https://saved.example" });
  assert.equal(resolveCredentials({}, config, { INBOUNDR_API_KEY: "inb_env" }).source, "env");
  assert.equal(resolveCredentials({ "api-key": "inb_flag" }, config, { INBOUNDR_API_KEY: "inb_env" }).apiKey, "inb_flag");
  assert.equal(resolveCredentials({}, {}, {}).apiKey, undefined);
});
