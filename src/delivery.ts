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

/**
 * Headers the CLI sets itself, which --header can't replace: the same set the
 * platform reserves for an endpoint's custom headers. fetch() would otherwise
 * merge a "Content-Type" or "X-Inboundr-Signature" given in another case into
 * ours ("text/plain, application/json"), breaking the request or its
 * signature.
 */
export const RESERVED_HEADERS = new Set([
  "content-type",
  "content-length",
  "host",
  "user-agent",
  "x-inboundr-event",
  "x-inboundr-delivery-id",
  "x-inboundr-email-id",
  "x-inboundr-id-signature",
  "x-inboundr-signature",
  "x-inbound-event",
  "x-inbound-delivery-id",
  "x-inbound-signature",
]);

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/; // RFC 9110 token
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

/** Why a header can't be sent, or null when it can. */
export function headerProblem(name: string, value: string): string | null {
  if (!HEADER_NAME.test(name)) return `"${name}" isn't a valid header name.`;
  if (RESERVED_HEADERS.has(name.toLowerCase())) return `"${name}" is set by the CLI and can't be overridden.`;
  if (!HEADER_VALUE.test(value)) return `The value of "${name}" contains characters a header can't carry.`;
  return null;
}

/**
 * Aborts when any of `signals` does. AbortSignal.any where it exists (Node
 * 20.3+); a manual fallback for the earliest Node 20 releases.
 */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  const any = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (any) return any(signals);
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
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
  options: {
    timeoutMs: number;
    userAgent: string;
    headers?: Record<string, string>;
    /** Ctrl-C: abandons a request your server is slow to answer. */
    signal?: AbortSignal;
  },
): Promise<ForwardResult> {
  const body = JSON.stringify(eventForEmail(email));
  const deliveryId = newDeliveryId();
  const timestamp = Math.floor(Date.now() / 1000);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: options.signal
        ? anySignal([AbortSignal.timeout(options.timeoutMs), options.signal])
        : AbortSignal.timeout(options.timeoutMs),
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
