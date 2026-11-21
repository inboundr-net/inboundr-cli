import assert from "node:assert/strict";
import { test } from "node:test";
import { newEmails } from "../dist/commands/listen.js";
import { safeFilename } from "../dist/commands/emails.js";
import { resolveCredentials } from "../dist/command.js";

test("newEmails walks pages until it reaches a seen email", async () => {
  const all = Array.from({ length: 120 }, (_, i) => ({ id: `em_${i}` })); // newest first
  const seen = new Set(["em_110", "em_111"]);
  const calls = [];
  const list = async (p) => {
    calls.push(p.cursor ?? null);
    const start = Number(p.cursor ?? 0);
    return { data: all.slice(start, start + 50), nextCursor: start + 50 < all.length ? String(start + 50) : null };
  };
  const fresh = await newEmails(list, { limit: 50 }, seen);
  assert.equal(fresh.length, 118);
  assert.deepEqual(calls, [null, "50", "100"]);
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
