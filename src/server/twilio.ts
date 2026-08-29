export interface TwilioBindings {
  /** The Twilio API Key SID (the value currently named TWILIO_SID). */
  TWILIO_SID?: string;
  TWILIO_CLIENT_SECRET?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_NUMBER?: string;
}

function base64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function bytes(value: string): Uint8Array {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function normalizePhoneNumber(value: string): string | null {
  const phone = value.trim();
  return /^\+[1-9][0-9]{7,14}$/.test(phone) ? phone : null;
}

export async function verifyTwilioSignature(
  url: string,
  form: URLSearchParams,
  signature: string | null,
  authSecret: string,
): Promise<boolean> {
  if (!signature || !authSecret) return false;
  try {
    const data = url + [...form.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}${value}`)
      .join("");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(authSecret),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify("HMAC", key, bytes(signature), new TextEncoder().encode(data));
  } catch {
    return false;
  }
}

export function twimlResponse(message?: string): Response {
  const body = message
    ? `<Response><Message>${escapeXml(message)}</Message></Response>`
    : "<Response></Response>";
  return new Response(body, {
    headers: { "Content-Type": "text/xml; charset=UTF-8" },
  });
}

export async function sendTwilioMessage(
  env: TwilioBindings,
  to: string,
  body: string,
): Promise<void> {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const apiKeySid = env.TWILIO_SID?.trim();
  const apiKeySecret = env.TWILIO_CLIENT_SECRET?.trim();
  const from = env.TWILIO_FROM_NUMBER?.trim();
  if (!accountSid || !apiKeySid || !apiKeySecret || !from) {
    throw new Error("Twilio SMS credentials and TWILIO_FROM_NUMBER are not configured.");
  }
  if (!normalizePhoneNumber(to) || !normalizePhoneNumber(from)) {
    throw new Error("Twilio SMS numbers must be E.164 phone numbers.");
  }

  const payload = new URLSearchParams({
    To: to,
    From: from,
    Body: body,
  });
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${base64(new TextEncoder().encode(`${apiKeySid}:${apiKeySecret}`))}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: payload,
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Twilio message failed (${response.status}): ${detail}`);
  }
}
