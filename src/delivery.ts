import { createHmac, randomBytes } from "node:crypto";
import type { Email } from "inboundr";

/**
 * A local copy of a real webhook delivery: the same JSON body, the same
 * headers, the same signatures. Mirrors `payloadForEmail` and
 * `deliveryHeaders` in the platform (src/lib/webhooks.ts and
 * src/lib/webhook-signature.ts); tests/delivery.test.mjs checks the result
 * against the `inboundr` SDK's own verifier.
 *
 * Key order matters only for humans reading the body — the signature is over
 * whatever bytes are sent — but it matches the platform's anyway, so a body
 * logged locally reads the same as one logged in production.
 */
export function eventForEmail(email: Email) {
  return {
    event: "email.received",
    email: {
      id: email.id,
      threadId: email.threadId,
      messageId: email.messageId,
      from: email.fromAddress,
      to: email.toAddresses,
      cc: email.ccAddresses,
      recipients: email.recipients,
      subject: email.subject,
      text: email.textBody,
      html: email.htmlBody,
      attachments: email.attachments.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
        downloadUrl: a.downloadUrl,
      })),
      verdicts: {
        spam: email.spamVerdict,
        spf: email.spfVerdict,
        dkim: email.dkimVerdict,
      },
      receivedAt: email.receivedAt,
    },
  };
}

function sign(secret: string, timestamp: number, message: string): string {
  const mac = createHmac("sha256", secret).update(message).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

export function deliveryHeaders(
  secret: string,
  body: string,
  timestamp: number,
  deliveryId: string,
  emailId: string,
): Record<string, string> {
  const signature = sign(secret, timestamp, `${timestamp}.${body}`);
  return {
    "x-inboundr-event": "email.received",
    "x-inboundr-delivery-id": deliveryId,
    "x-inboundr-email-id": emailId,
    "x-inboundr-id-signature": sign(secret, timestamp, `ids.${timestamp}.${deliveryId}.${emailId}`),
    "x-inboundr-signature": signature,
    "x-inbound-event": "email.received",
    "x-inbound-delivery-id": deliveryId,
    "x-inbound-signature": signature,
  };
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** `del_` and 20 characters, the platform's delivery id format. */
export function newDeliveryId(): string {
  const bytes = randomBytes(20);
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return `del_${out}`;
}

/** Same format as an endpoint's secret: `whsec_` and 24 random bytes. */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

export type ForwardResult = {
  deliveryId: string;
  status: number | null;
  durationMs: number;
  error: string | null;
  responseBody: string | null;
};

/** POSTs one email to `url` as a signed delivery. Never throws. */
export async function forward(
  url: string,
  email: Email,
  secret: string,
  options: { timeoutMs: number; userAgent: string; headers?: Record<string, string> },
): Promise<ForwardResult> {
  const body = JSON.stringify(eventForEmail(email));
  const deliveryId = newDeliveryId();
  const timestamp = Math.floor(Date.now() / 1000);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: {
        ...options.headers,
        "content-type": "application/json",
        "user-agent": options.userAgent,
        ...deliveryHeaders(secret, body, timestamp, deliveryId, email.id),
      },
      body,
    });
    const text = await res.text().catch(() => "");
    return {
      deliveryId,
      status: res.status,
      durationMs: Math.round(performance.now() - started),
      error: null,
      responseBody: text ? text.slice(0, 2000) : null,
    };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    const error =
      e.name === "TimeoutError"
        ? `timed out after ${options.timeoutMs / 1000}s`
        : e.cause?.code === "ECONNREFUSED"
          ? "connection refused — is your server running?"
          : (e.cause as Error | undefined)?.message === "bad port"
            ? `fetch won't connect to port ${new URL(url).port}; run your server on another port`
            : (e.cause as Error | undefined)?.message || e.message;
    return {
      deliveryId,
      status: null,
      durationMs: Math.round(performance.now() - started),
      error,
      responseBody: null,
    };
  }
}
