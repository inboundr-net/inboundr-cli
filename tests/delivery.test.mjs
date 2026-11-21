import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyWebhookDeliveryPayload, verifyWebhookIds } from "inboundr";
import { deliveryHeaders, eventForEmail, newDeliveryId, newWebhookSecret } from "../dist/delivery.js";
import { makeEmail } from "./fake-api.mjs";

// The point of `listen` is that a handler can't tell its deliveries from real
// ones, so this checks them with the published SDK's own verifier rather than
// re-deriving the HMAC here.
test("a local delivery passes the SDK's combined verification", async () => {
  const secret = newWebhookSecret();
  const email = makeEmail();
  const body = JSON.stringify(eventForEmail(email));
  const deliveryId = newDeliveryId();
  const headers = deliveryHeaders(secret, body, Math.floor(Date.now() / 1000), deliveryId, email.id);

  const verified = await verifyWebhookDeliveryPayload(body, headers, secret);
  assert.equal(verified.deliveryId, deliveryId);
  assert.equal(verified.event.event, "email.received");
  assert.equal(verified.event.email.id, email.id);
  assert.equal(verified.event.email.from, "jane@example.com");
  assert.equal(verified.event.email.text, "Where is my order?");

  const ids = await verifyWebhookIds(headers, secret);
  assert.equal(ids.emailId, email.id);
});

test("the wrong secret or a changed body fails", async () => {
  const secret = newWebhookSecret();
  const email = makeEmail();
  const body = JSON.stringify(eventForEmail(email));
  const headers = deliveryHeaders(secret, body, Math.floor(Date.now() / 1000), newDeliveryId(), email.id);
  await assert.rejects(verifyWebhookDeliveryPayload(body, headers, newWebhookSecret()), { reason: "invalid_signature" });
  await assert.rejects(verifyWebhookDeliveryPayload(body.replace("order", "ordre"), headers, secret), { reason: "invalid_signature" });
});

test("the payload has the platform's fields, in its order", () => {
  const event = eventForEmail(makeEmail());
  assert.deepEqual(Object.keys(event), ["event", "email"]);
  assert.deepEqual(Object.keys(event.email), [
    "id", "threadId", "messageId", "from", "to", "cc", "recipients", "subject",
    "text", "html", "attachments", "verdicts", "receivedAt",
  ]);
  assert.deepEqual(Object.keys(event.email.attachments[0]), ["filename", "contentType", "size", "downloadUrl"]);
  assert.deepEqual(Object.keys(event.email.verdicts), ["spam", "spf", "dkim"]);
});

test("ids and secrets use the platform's formats", () => {
  assert.match(newDeliveryId(), /^del_[0-9a-z]{20}$/);
  assert.match(newWebhookSecret(), /^whsec_[A-Za-z0-9_-]{32}$/);
  assert.notEqual(newDeliveryId(), newDeliveryId());
});
