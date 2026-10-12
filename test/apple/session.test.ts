import { createHash, pbkdf2Sync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppleAuthError, AppleSession, type ApplePrompts } from "../../src/apple/index.ts";
import { leadingZeroBits } from "../../src/apple/hashcash.ts";
import { fromBytes, modPow, toBytes } from "../../src/apple/srp.ts";

// ── A fake Apple: the server side of SRP plus the idmsa, olympus, portal and iris endpoints ──

const N = BigInt(
  "0xac6bdb41324a9a9bf166de5e1389582faf72b6651987ee07fc3192943db56050a37329cbb4a099ed8193e0757767a13dd52312ab4b03310dcd7f48a9da04fd50e8083969edb767b0cf6095179a163ab3661a05fbd5faaae82918a9962f0b93b855f97993ec975eeaa80d740adbf4ff747359d041d5c33ea71d281e446b14773bca97b43a23fb801676bd207a436c6481f1d2b9078717461a5b9d32e688f87748544523b524b0d57d5ea77a2775d2ecfa032cfbdbf52fb3786160279004e57ae6af874e7303ce53299ccc041c7bc308d82a5698f3a8d0c38271ae35f8e9dbfbb694b5c803d89f7ae435de236d525f54759b65e372fcd68ef20fa7111f9e4aff73",
);
const sha = (...p: Uint8Array[]) => {
  const h = createHash("sha256");
  for (const x of p) h.update(x);
  return new Uint8Array(h.digest());
};
const pad = (n: bigint) => {
  const b = toBytes(n);
  const out = new Uint8Array(256);
  out.set(b, 256 - b.length);
  return out;
};

type Scenario = { password: string; twoFactor: "none" | "device" | "sms"; apiKeyError?: { status: number; errors: object[] } };

const PEM = "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----\n";

function fakeApple(s: Scenario) {
  const salt = new Uint8Array(16).fill(7);
  const iterations = 1000;
  const key = pbkdf2Sync(createHash("sha256").update(s.password).digest(), salt, iterations, 32, "sha256");
  const x = fromBytes(sha(salt, sha(new Uint8Array([0x3a]), key)));
  const v = modPow(2n, x, N);
  const k = fromBytes(sha(toBytes(N), pad(2n)));
  const b = 123456789n;
  const B = (k * v + modPow(2n, b, N)) % N;
  let A = 0n;
  const calls: string[] = [];
  const state = { codes: 0, smsRequested: false, signedIn: false, provider: 1001 };

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const loggedInCookies = { "Set-Cookie": "myacinfo=SESSION; Domain=.apple.com; Path=/; Secure" };

  const fetchFn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body) || "null") : null;
    const route = `${method} ${url.host}${url.pathname}`;
    calls.push(route);
    const cookie = headers.get("cookie") ?? "";
    const needs2fa = () => headers.get("scnt") === "SCNT" && headers.get("x-apple-id-session-id") === "SID";

    switch (route) {
      case "HEAD appstoreconnect.apple.com/logout":
        if (cookie) throw new Error("logout must be fetched without cookies");
        return new Response(null, { status: 302, headers: { Location: "https://idmsa.apple.com/IDMSWebAuth/signout?widgetKey=WIDGET&asop=destroy-session" } });
      case "GET idmsa.apple.com/appleauth/auth/signin":
        return new Response("<html/>", { status: 200, headers: { "X-Apple-HC-Bits": "10", "X-Apple-HC-Challenge": "c0ffee" } });
      case "POST idmsa.apple.com/appleauth/auth/signin/init":
        if (headers.get("x-apple-widget-key") !== "WIDGET") return json(400, {});
        A = fromBytes(new Uint8Array(Buffer.from(body.a, "base64")));
        return json(200, { iteration: iterations, salt: Buffer.from(salt).toString("base64"), protocol: "s2k", b: Buffer.from(toBytes(B)).toString("base64"), c: "C-TOKEN" });
      case "POST idmsa.apple.com/appleauth/auth/signin/complete": {
        const hc = headers.get("x-apple-hc") ?? "";
        if (!hc.startsWith("1:10:") || !hc.includes(":c0ffee::") || leadingZeroBits(createHash("sha1").update(hc).digest()) < 10) return json(400, { error: "hashcash" });
        if (body.c !== "C-TOKEN" || body.accountName !== "dev@example.com") return json(400, {});
        const u = fromBytes(sha(pad(A), pad(B)));
        const S = modPow((A * modPow(v, u, N)) % N, b, N);
        const K = sha(toBytes(S));
        const xor = sha(toBytes(N)).map((byte, i) => byte ^ sha(pad(2n))[i]!);
        const m1 = sha(xor, sha(Buffer.from(body.accountName)), salt, toBytes(A), toBytes(B), K);
        if (Buffer.from(m1).toString("base64") !== body.m1) return json(401, { serviceErrors: [{ code: "-20101", message: "Your Apple ID or password was entered incorrectly." }] });
        if (Buffer.from(sha(toBytes(A), m1, K)).toString("base64") !== body.m2) return json(400, { error: "m2" });
        if (s.twoFactor === "none") {
          state.signedIn = true;
          return json(200, {}, loggedInCookies);
        }
        return json(409, { authType: "hsa2" }, { "X-Apple-ID-Session-Id": "SID", scnt: "SCNT" });
      }
      case "GET idmsa.apple.com/appleauth/auth":
        if (!needs2fa()) return json(401, {});
        return json(200, {
          trustedPhoneNumbers: [{ id: 1, numberWithDialCode: "+91 ••••• •••12", pushMode: "sms" }, { id: 2, numberWithDialCode: "+1 (•••) •••-••34", pushMode: "sms" }],
          securityCode: { length: 6, tooManyCodesSent: false },
          noTrustedDevices: false,
        });
      case "POST idmsa.apple.com/appleauth/auth/verify/trusteddevice/securitycode":
        if (!needs2fa()) return json(401, {});
        state.codes++;
        if (body.securityCode.code !== "123456") return json(400, { service_errors: [{ code: "-21669", message: "Incorrect verification code." }] });
        state.signedIn = true;
        return new Response(null, { status: 204, headers: loggedInCookies });
      case "PUT idmsa.apple.com/appleauth/auth/verify/phone":
        if (!needs2fa() || body.phoneNumber.id !== 2 || body.mode !== "sms") return json(400, {});
        state.smsRequested = true;
        return json(200, { phoneNumber: { id: 2 } });
      case "POST idmsa.apple.com/appleauth/auth/verify/phone/securitycode":
        if (!needs2fa() || !state.smsRequested || body.securityCode.code !== "654321" || body.phoneNumber.id !== 2) return json(400, { service_errors: [{ message: "Incorrect verification code." }] });
        state.signedIn = true;
        return new Response(null, { status: 204, headers: loggedInCookies });
      case "GET idmsa.apple.com/appleauth/auth/2sv/trust":
        if (!needs2fa()) return json(401, {});
        return new Response(null, { status: 204, headers: { "Set-Cookie": 'DES5c1485="HSARM==SRVX"; Domain=idmsa.apple.com; Path=/; Max-Age=2592000; Secure' } });
      case "GET appstoreconnect.apple.com/olympus/v1/session": {
        if (!cookie.includes("myacinfo=SESSION")) return json(401, {});
        const providers = [
          { providerId: 1001, publicProviderId: "pub-1001", name: "Sreeyesh K" },
          { providerId: 2002, publicProviderId: "pub-2002", name: "InstaSupply Inc" },
        ];
        return json(200, { provider: providers.find((p) => p.providerId === state.provider), availableProviders: providers });
      }
      case "POST developer.apple.com/services-account/QH65B2/account/listTeams.action":
        if (!cookie.includes("myacinfo=SESSION")) return json(401, {});
        return json(200, { teams: [{ teamId: "BBBBBBBBBB", name: "InstaSupply Inc" }, { teamId: "AAAAAAAAAA", name: "Sreeyesh K" }] });
      case "POST appstoreconnect.apple.com/olympus/v1/providerSwitchRequests":
        state.provider = body.data.relationships.provider.data.id === "pub-2002" ? 2002 : 1001;
        return json(201, {});
      case "POST appstoreconnect.apple.com/iris/v1/apiKeys":
        if (s.apiKeyError) return json(s.apiKeyError.status, { errors: s.apiKeyError.errors });
        if (body.data.attributes.roles[0] !== "ADMIN" || body.data.attributes.keyType !== "PUBLIC_API" || !body.data.attributes.allAppsVisible) return json(422, {});
        return json(201, { data: { id: "KEY1234567", type: "apiKeys", attributes: { nickname: body.data.attributes.nickname } } });
      case "GET appstoreconnect.apple.com/iris/v1/apiKeys/KEY1234567":
        if (url.searchParams.get("fields[apiKeys]") === "privateKey") return json(200, { data: { id: "KEY1234567", attributes: { privateKey: Buffer.from(PEM).toString("base64") } } });
        return json(200, { data: { id: "KEY1234567", relationships: { provider: { data: { type: "providers", id: `issuer-${state.provider}` } } } } });
    }
    return json(404, { route });
  }) as unknown as typeof fetch;

  return { fetchFn, calls, state };
}

function prompts(answers: (string | { sms: number })[], password = "hunter2!") {
  const seen: Parameters<ApplePrompts["code"]>[0][] = [];
  let passwordAsked = 0;
  const p: ApplePrompts = {
    password: async () => {
      passwordAsked++;
      return password;
    },
    code: async (info) => {
      seen.push(info);
      const next = answers.shift();
      if (next === undefined) throw new Error("unexpected code prompt");
      return next;
    },
  };
  return { p, seen, passwordAsked: () => passwordAsked };
}

const tempDir = () => mkdtempSync(join(tmpdir(), "liftbay-apple-"));

describe("AppleSession", () => {
  it("signs in without 2FA, lists teams, switches provider and creates an API key", async () => {
    const apple = fakeApple({ password: "hunter2!", twoFactor: "none" });
    const configDir = tempDir();
    const pr = prompts([]);
    const session = await AppleSession.signIn("  Dev@Example.com ", pr.p, { fetch: apple.fetchFn, configDir });

    const teams = await session.teams();
    expect(teams).toEqual([
      { teamId: "BBBBBBBBBB", name: "InstaSupply Inc", providerId: 2002 },
      { teamId: "AAAAAAAAAA", name: "Sreeyesh K", providerId: 1001 },
    ]);
    await session.selectTeam(teams[0]!);
    expect(apple.state.provider).toBe(2002);

    const key = await session.createApiKey("Liftbay");
    expect(key).toEqual({ keyId: "KEY1234567", issuerId: "issuer-2002", privateKeyP8: PEM });
  });

  it("asks for the device code, retries a wrong one, trusts the machine and reuses the saved session", async () => {
    const apple = fakeApple({ password: "hunter2!", twoFactor: "device" });
    const configDir = tempDir();
    const first = prompts(["000000", "123456"]);
    const session = await AppleSession.signIn("dev@example.com", first.p, { fetch: apple.fetchFn, configDir });
    expect(first.seen[0]).toEqual({ length: 6, phones: [{ id: 1, number: "+91 ••••• •••12" }, { id: 2, number: "+1 (•••) •••-••34" }], deviceCode: true });
    expect(apple.state.codes).toBe(2);
    expect(apple.calls).toContain("GET idmsa.apple.com/appleauth/auth/2sv/trust");

    const file = join(configDir, `${createHash("sha256").update("dev@example.com").digest("hex")}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = readFileSync(file, "utf8");
    expect(saved).toContain("myacinfo");
    expect(saved).not.toContain("hunter2");

    // Second run: no password, no code.
    const again = prompts([]);
    await AppleSession.signIn("DEV@example.com", again.p, { fetch: apple.fetchFn, configDir });
    expect(again.passwordAsked()).toBe(0);

    session.signOut();
    expect(existsSync(file)).toBe(false);
  });

  it("texts a code to the chosen number", async () => {
    const apple = fakeApple({ password: "hunter2!", twoFactor: "sms" });
    const pr = prompts([{ sms: 2 }, "654321"]);
    await AppleSession.signIn("dev@example.com", pr.p, { fetch: apple.fetchFn, configDir: tempDir() });
    expect(apple.state.smsRequested).toBe(true);
    expect(pr.seen[1]).toEqual({ length: 6, phones: [], deviceCode: false });
  });

  it("gives up after three wrong codes", async () => {
    const apple = fakeApple({ password: "hunter2!", twoFactor: "device" });
    const pr = prompts(["1", "2", "3"]);
    const err = await AppleSession.signIn("dev@example.com", pr.p, { fetch: apple.fetchFn, configDir: tempDir() }).catch((e) => e);
    expect(err).toBeInstanceOf(AppleAuthError);
    expect(err.code).toBe("2fa_failed");
  });

  it("reports a wrong password", async () => {
    const apple = fakeApple({ password: "the-real-one", twoFactor: "none" });
    const err = await AppleSession.signIn("dev@example.com", prompts([], "wrong").p, { fetch: apple.fetchFn, configDir: tempDir() }).catch((e) => e);
    expect(err).toBeInstanceOf(AppleAuthError);
    expect(err.code).toBe("bad_credentials");
  });

  it("maps API key errors", async () => {
    const cases: [object[], number, string][] = [
      [[{ code: "FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED", title: "A required agreement is missing or has expired." }], 403, "agreement_required"],
      [[{ code: "FORBIDDEN_ERROR", title: "Access to the App Store Connect API has not been requested" , detail: "Request access in Integrations." }], 403, "api_access_not_enabled"],
      [[{ code: "FORBIDDEN_ERROR", title: "The resource cannot be created." }], 403, "not_admin"],
    ];
    for (const [errors, status, code] of cases) {
      const apple = fakeApple({ password: "hunter2!", twoFactor: "none", apiKeyError: { status, errors } });
      const session = await AppleSession.signIn("dev@example.com", prompts([]).p, { fetch: apple.fetchFn, configDir: tempDir() });
      const err = await session.createApiKey("Liftbay").catch((e) => e);
      expect(err.code).toBe(code);
    }
  });

  it("forgets a saved session without signing in", async () => {
    const apple = fakeApple({ password: "hunter2!", twoFactor: "none" });
    const configDir = tempDir();
    await AppleSession.signIn("dev@example.com", prompts([]).p, { fetch: apple.fetchFn, configDir });
    const file = join(configDir, `${createHash("sha256").update("dev@example.com").digest("hex")}.json`);
    expect(existsSync(file)).toBe(true);
    AppleSession.forget("Dev@Example.com", { configDir });
    expect(existsSync(file)).toBe(false);
  });
});
