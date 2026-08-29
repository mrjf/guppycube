import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { app } from "../src/server";
import { normalizePhoneNumber } from "../src/server/twilio";

const AUTH_TOKEN = "test-twilio-auth-token";

async function twilioSignature(url: string, form: URLSearchParams): Promise<string> {
  const data = url + [...form.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}${value}`)
    .join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(AUTH_TOKEN),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...digest));
}

describe("Twilio SMS integration", () => {
  test("normalizes only E.164 phone numbers", () => {
    expect(normalizePhoneNumber(" +14155551212 ")).toBe("+14155551212");
    expect(normalizePhoneNumber("415-555-1212")).toBeNull();
  });

  test("accepts a signed help webhook and rejects an invalid signature", async () => {
    const url = "http://127.0.0.1/api/twilio/sms";
    const publicUrl = "http://127.0.0.1/guppycube/api/twilio/sms";
    const form = new URLSearchParams({ Body: "help", From: "+14155551212" });
    const signature = await twilioSignature(publicUrl, form);
    const bindings = { ...env, TWILIO_AUTH_TOKEN: AUTH_TOKEN };

    const valid = await app.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature,
        "X-Guppycube-Base": "/guppycube",
      },
      body: form,
    }, bindings);
    expect(valid.status).toBe(200);
    expect(await valid.text()).toContain("SUBSCRIBE &lt;table code&gt;");

    const invalid = await app.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": "not-valid",
      },
      body: form,
    }, bindings);
    expect(invalid.status).toBe(403);
  });

  test("accepts a full game link in a subscription message", async () => {
    const bindings = { ...env, TWILIO_AUTH_TOKEN: AUTH_TOKEN };
    const create = await app.request("http://127.0.0.1/api/games", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "SMS Host", mode: "realtime", maxPlayers: 2 }),
    }, bindings);
    expect(create.status).toBe(201);
    const { roomCode } = await create.json<{ roomCode: string }>();

    const url = "http://127.0.0.1/api/twilio/sms";
    const form = new URLSearchParams({
      Body: `subscribe me to https://snagsby.com/guppycube/room/${roomCode}`,
      From: "+14155551212",
    });
    const response = await app.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": await twilioSignature(url, form),
      },
      body: form,
    }, bindings);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`Subscribed to ${roomCode}`);
  });
});
