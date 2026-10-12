import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CookieJar, type StoredCookie } from "./cookies.ts";
import { AppleAuthError } from "./errors.ts";
import { makeHashcash } from "./hashcash.ts";
import { derivePasswordKey, SrpClient } from "./srp.ts";

/**
 * Apple ID sign-in from the developer's machine, the way the App Store Connect website does it.
 * The flow follows fastlane spaceship (client.rb, two_step_or_factor_client.rb) and EAS (@expo/apple-utils).
 * The password never leaves this process except as an SRP proof to Apple; the session cookies are kept
 * in ~/.liftbay/apple (0600) so the next run skips 2FA while Apple keeps the session alive.
 */

export type ApplePrompts = {
  password(appleId: string): Promise<string>;
  /** Called when Apple needs 2FA. Return the code; or { sms: phoneId } to ask for an SMS to a trusted number instead. */
  code(info: { length: number; phones: { id: number; number: string }[]; deviceCode: boolean }): Promise<string | { sms: number }>;
};

export type AppleTeam = { teamId: string; name: string; providerId: number | null };

type Options = { fetch?: typeof fetch; configDir?: string; log?: (m: string) => void };

type Provider = { providerId: number; publicProviderId: string; name: string };
type OlympusSession = { provider?: Provider; availableProviders?: Provider[] };
type Saved = { appleId: string; cookies: StoredCookie[] };
type Response = { status: number; headers: Headers; data: any };

const IDMSA = "https://idmsa.apple.com/appleauth";
const ASC = "https://appstoreconnect.apple.com";
const PORTALS = ["https://developer.apple.com", "https://developer-mdn.apple.com"];
const MAX_CODE_ATTEMPTS = 3;

const sessionDir = (configDir?: string) => configDir ?? join(process.env.LIFTBAY_CONFIG_DIR ?? join(homedir(), ".liftbay"), "apple");
const accountName = (appleId: string) => appleId.trim().toLowerCase();
const sessionFile = (appleId: string, configDir?: string) => join(sessionDir(configDir), `${createHash("sha256").update(accountName(appleId)).digest("hex")}.json`);

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function serviceError(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { serviceErrors?: { message?: string; code?: string }[]; service_errors?: { message?: string }[] };
  const errs = d.serviceErrors ?? d.service_errors;
  return errs?.length ? errs.map((e) => e.message ?? "").filter(Boolean).join(" ") : null;
}

export class AppleSession {
  private olympus: OlympusSession | null = null;
  private portal: string | null = null;

  private constructor(
    readonly appleId: string,
    private readonly jar: CookieJar,
    private readonly opts: Options,
  ) {}

  // ── Sign-in ─────────────────────────────────────────────────────────

  /** Signs in (SRP + hashcash + 2FA), reusing a saved session from ~/.liftbay/apple/<sha256(appleId)>.json (0600) when still valid. */
  static async signIn(appleId: string, prompts: ApplePrompts, opts: Options = {}): Promise<AppleSession> {
    const file = sessionFile(appleId, opts.configDir);
    if (existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, "utf8")) as Saved;
        const restored = new AppleSession(appleId, new CookieJar(saved.cookies), opts);
        if (await restored.fetchOlympus()) {
          opts.log?.(`Using the saved Apple session for ${appleId}`);
          return restored;
        }
      } catch {
        // A corrupt or stale file is just a reason to sign in again.
      }
    }

    const session = new AppleSession(appleId, new CookieJar(), opts);
    await session.login(await prompts.password(appleId), prompts);
    if (!(await session.fetchOlympus())) {
      throw new AppleAuthError("unexpected", "Apple accepted the sign-in but App Store Connect refused the session. Sign in at https://appstoreconnect.apple.com once to accept any pending terms, then try again.");
    }
    session.save();
    return session;
  }

  /** Deletes the saved session file for that Apple ID without signing in. */
  static forget(appleId: string, opts: { configDir?: string } = {}): void {
    rmSync(sessionFile(appleId, opts.configDir), { force: true });
  }

  /** Deletes the saved session file. */
  signOut(): void {
    AppleSession.forget(this.appleId, this.opts);
  }

  private save() {
    const dir = sessionDir(this.opts.configDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = sessionFile(this.appleId, this.opts.configDir);
    writeFileSync(file, JSON.stringify({ appleId: accountName(this.appleId), cookies: this.jar.toJSON() } satisfies Saved), { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  private async login(password: string, prompts: ApplePrompts) {
    const name = accountName(this.appleId);
    const widgetKey = await this.widgetKey();
    const base = {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-Apple-Widget-Key": widgetKey,
      Accept: "application/json, text/javascript",
    };

    // Proof of work Apple asks for before it accepts a sign-in (absent on some accounts).
    const challenge = await this.request("GET", `${IDMSA}/auth/signin?widgetKey=${encodeURIComponent(widgetKey)}`, {
      headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });
    const bits = challenge.headers.get("x-apple-hc-bits");
    const hcChallenge = challenge.headers.get("x-apple-hc-challenge");
    const hashcash = bits && hcChallenge ? makeHashcash(Number(bits), hcChallenge) : null;

    const srp = new SrpClient();
    const init = await this.request("POST", `${IDMSA}/auth/signin/init`, {
      headers: base,
      json: { a: b64(srp.publicValue), accountName: name, protocols: ["s2k", "s2k_fo"] },
    });
    if (init.status !== 200 || typeof init.data !== "object" || !init.data?.salt) {
      throw this.signInError(init, "Apple did not start the sign-in");
    }
    const salt = new Uint8Array(Buffer.from(init.data.salt, "base64"));
    const key = derivePasswordKey(password, salt, Number(init.data.iteration), String(init.data.protocol));
    const { m1, m2 } = srp.proof(name, key, salt, new Uint8Array(Buffer.from(init.data.b, "base64")));

    const complete = await this.request("POST", `${IDMSA}/auth/signin/complete?isRememberMeEnabled=true`, {
      headers: { ...base, ...(hashcash ? { "X-Apple-HC": hashcash } : {}) },
      json: { accountName: name, c: init.data.c, m1: b64(m1), m2: b64(m2), rememberMe: true },
    });
    if (complete.status === 200) return;
    if (complete.status === 409) {
      await this.twoFactor(prompts, {
        "X-Apple-Id-Session-Id": complete.headers.get("x-apple-id-session-id") ?? "",
        scnt: complete.headers.get("scnt") ?? "",
        "X-Apple-Widget-Key": widgetKey,
        Accept: "application/json",
      });
      return;
    }
    throw this.signInError(complete, "Apple refused the sign-in");
  }

  private signInError(r: Response, fallback: string): AppleAuthError {
    const message = serviceError(r.data);
    if (r.status === 412) {
      return new AppleAuthError(
        "unexpected",
        "Apple needs you to accept its Apple ID and privacy terms first: sign in once at https://appleid.apple.com or https://appstoreconnect.apple.com, then try again.",
      );
    }
    if (r.status === 403 || /locked|disabled/i.test(message ?? "")) {
      return new AppleAuthError("locked", message ?? "This Apple ID is locked. Unlock it at https://iforgot.apple.com, then try again.");
    }
    if (r.status === 401 || (typeof r.data === "string" && r.data.includes('invalid="true"')) || r.status === 400) {
      return new AppleAuthError("bad_credentials", "Wrong Apple ID or password.");
    }
    return new AppleAuthError("unexpected", `${fallback} (${r.status})${message ? `: ${message}` : ""}`);
  }

  /** Trusted-device code by default; an SMS to a trusted number on request (spaceship handle_two_factor). */
  private async twoFactor(prompts: ApplePrompts, headers: Record<string, string>) {
    const options = await this.request("GET", `${IDMSA}/auth`, { headers });
    const data = options.data ?? {};
    const phones: { id: number; number: string; pushMode?: string }[] = (data.trustedPhoneNumbers ?? []).map(
      (p: { id: number; numberWithDialCode?: string; obfuscatedNumber?: string; pushMode?: string }) => ({ id: p.id, number: p.numberWithDialCode ?? p.obfuscatedNumber ?? String(p.id), pushMode: p.pushMode }),
    );
    if (!data.securityCode && !phones.length) {
      const why = serviceError(data);
      throw new AppleAuthError(
        "2fa_failed",
        `Apple could not start two-factor authentication${why ? `: ${why}` : ""}.${data.noTrustedDevices ? " This Apple ID has no trusted devices: signing in to it on an Apple device adds one." : ""}`,
      );
    }
    const length: number = data.securityCode?.length ?? 6;
    const noDevices = !!data.noTrustedDevices;

    // With no trusted device and a single number, Apple has already texted the code.
    let sms: { id: number; mode: string } | null = noDevices && phones.length === 1 ? { id: phones[0]!.id, mode: phones[0]!.pushMode ?? "sms" } : null;

    for (let attempt = 1; ; attempt++) {
      let answer = await prompts.code(sms ? { length, phones: [], deviceCode: false } : { length, phones: phones.map(({ id, number }) => ({ id, number })), deviceCode: !noDevices });
      if (typeof answer !== "string") {
        const smsId = answer.sms;
        const phone = phones.find((p) => p.id === smsId);
        if (!phone) throw new AppleAuthError("2fa_failed", "Unknown phone number");
        sms = { id: phone.id, mode: phone.pushMode ?? "sms" };
        const sent = await this.request("PUT", `${IDMSA}/auth/verify/phone`, { headers, json: { phoneNumber: { id: sms.id }, mode: sms.mode } });
        if (sent.status >= 400) throw new AppleAuthError("2fa_failed", `Apple could not send the text message${serviceError(sent.data) ? `: ${serviceError(sent.data)}` : ""}`);
        this.opts.log?.(`Apple texted a code to ${phone.number}`);
        answer = await prompts.code({ length, phones: [], deviceCode: false });
        if (typeof answer !== "string") throw new AppleAuthError("2fa_failed", "Enter the code from the text message");
      }

      const verify = sms
        ? await this.request("POST", `${IDMSA}/auth/verify/phone/securitycode`, { headers, json: { securityCode: { code: answer.trim() }, phoneNumber: { id: sms.id }, mode: sms.mode } })
        : await this.request("POST", `${IDMSA}/auth/verify/trusteddevice/securitycode`, { headers, json: { securityCode: { code: answer.trim() } } });
      if (verify.status >= 200 && verify.status < 300) break;
      const why = serviceError(verify.data) ?? "";
      if (/verification code/i.test(why) && attempt < MAX_CODE_ATTEMPTS) {
        this.opts.log?.("Incorrect verification code, try again");
        continue;
      }
      throw new AppleAuthError("2fa_failed", why || `Apple rejected the verification code (${verify.status})`);
    }

    // Marks this machine as trusted: Apple returns longer-lived cookies, so the next sign-in skips 2FA.
    await this.request("GET", `${IDMSA}/auth/2sv/trust`, { headers });
  }

  /**
   * The widget key ("authServiceKey") Apple's sign-in pages use. Read from the sign-out redirect's Location,
   * without cookies and without following it (following it would end a session); the olympus config
   * endpoint is only a fallback, since Apple removed it in September 2026 (fastlane#30199, EAS does the same).
   */
  private async widgetKey(): Promise<string> {
    const f = this.opts.fetch ?? fetch;
    try {
      const res = await f(`${ASC}/logout`, { method: "HEAD", redirect: "manual" });
      const location = res.headers.get("location");
      const key = location ? new URL(location, ASC).searchParams.get("widgetKey") : null;
      if (key) return key;
    } catch {
      // Fall through to the old endpoint.
    }
    const r = await this.request("GET", `${ASC}/olympus/v1/app/config?hostname=itunesconnect.apple.com`);
    if (r.status === 200 && r.data?.authServiceKey) return r.data.authServiceKey;
    throw new AppleAuthError("unexpected", `Could not find Apple's sign-in key (App Store Connect returned ${r.status}). Apple may have changed its sign-in; try again later or use a .p8 API key.`);
  }

  /** The App Store Connect session; null when not signed in. */
  private async fetchOlympus(): Promise<OlympusSession | null> {
    const r = await this.request("GET", `${ASC}/olympus/v1/session`, { headers: { Accept: "application/json" } });
    if (r.status !== 200 || typeof r.data !== "object" || !r.data?.provider) return null;
    this.olympus = r.data as OlympusSession;
    return this.olympus;
  }

  // ── Teams ───────────────────────────────────────────────────────────

  /** Developer teams (10-character team ids), each mapped to its App Store Connect provider by name, as EAS does. */
  async teams(): Promise<AppleTeam[]> {
    const r = await this.portalRequest("account/listTeams.action");
    const teams: { teamId: string; name: string }[] = r.data?.teams ?? [];
    const providers = this.olympus?.availableProviders ?? (this.olympus?.provider ? [this.olympus.provider] : []);
    return teams
      .map((t) => ({ teamId: t.teamId, name: t.name, providerId: providers.find((p) => p.name.startsWith(t.name))?.providerId ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.teamId.localeCompare(b.teamId));
  }

  /** Switches the App Store Connect session to the team's provider when the account has several. */
  async selectTeam(team: AppleTeam): Promise<void> {
    if (!this.olympus) await this.fetchOlympus();
    if (team.providerId === null || this.olympus?.provider?.providerId === team.providerId) return;
    const provider = this.olympus?.availableProviders?.find((p) => p.providerId === team.providerId);
    if (!provider) throw new AppleAuthError("unexpected", `This Apple ID has no App Store Connect access to ${team.name}`);
    const r = await this.request("POST", `${ASC}/olympus/v1/providerSwitchRequests`, {
      headers: { "X-Requested-With": "xsdr2$", Accept: "application/vnd.api+json", "Content-Type": "application/vnd.api+json" },
      json: { data: { type: "providerSwitchRequests", relationships: { provider: { data: { type: "providers", id: provider.publicProviderId } } } } },
    });
    if (r.status < 200 || r.status >= 300) throw new AppleAuthError("unexpected", `Could not switch App Store Connect to ${team.name} (${r.status})`);
    await this.fetchOlympus();
    this.save();
  }

  /** The developer portal answers on developer.apple.com, or developer-mdn.apple.com during migrations (EAS tries both). */
  private async portalRequest(path: string): Promise<Response> {
    const hosts = this.portal ? [this.portal] : PORTALS;
    let last: Response | null = null;
    for (const host of hosts) {
      const r = await this.request("POST", `${host}/services-account/QH65B2/${path}`, {
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: "",
      });
      if (r.status === 200 && typeof r.data === "object") {
        this.portal = host;
        return r;
      }
      last = r;
    }
    if (last?.status === 401 || last?.status === 403) throw new AppleAuthError("unexpected", "The Apple developer portal refused the session. Sign in again with --sign-out first.");
    throw new AppleAuthError("unexpected", `The Apple developer portal returned ${last?.status ?? "no response"} for ${path}`);
  }

  // ── API key ─────────────────────────────────────────────────────────

  /** Creates an App Store Connect API key (role ADMIN, all apps) named e.g. "Liftbay" and returns its one-time private key. */
  async createApiKey(nickname: string): Promise<{ keyId: string; issuerId: string; privateKeyP8: string }> {
    const iris = { Accept: "application/vnd.api+json", "Content-Type": "application/vnd.api+json", "X-Requested-With": "XMLHttpRequest" };
    // Same shape EAS sends (ApiKey.createAsync).
    const created = await this.request("POST", `${ASC}/iris/v1/apiKeys`, {
      headers: iris,
      json: { data: { type: "apiKeys", attributes: { nickname, allAppsVisible: true, roles: ["ADMIN"], keyType: "PUBLIC_API" } } },
    });
    if (created.status !== 201 && created.status !== 200) throw apiKeyError(created);
    const keyId: string = created.data?.data?.id;
    if (!keyId) throw new AppleAuthError("unexpected", "App Store Connect created no API key id");

    // The private key can be downloaded once; the issuer id is the key's provider (EAS api-key:bootstrap).
    const withKey = await this.request("GET", `${ASC}/iris/v1/apiKeys/${keyId}?fields[apiKeys]=privateKey`, { headers: iris });
    const encoded: string | undefined = withKey.data?.data?.attributes?.privateKey;
    if (!encoded) throw new AppleAuthError("unexpected", `App Store Connect did not return the private key for ${keyId}. Revoke that key in App Store Connect and try again.`);
    const withProvider = await this.request("GET", `${ASC}/iris/v1/apiKeys/${keyId}?include=provider`, { headers: iris });
    const issuerId: string | undefined = withProvider.data?.data?.relationships?.provider?.data?.id ?? withProvider.data?.included?.find((i: { type: string }) => i.type === "providers")?.id;
    if (!issuerId) throw new AppleAuthError("unexpected", "App Store Connect did not return the issuer id for the new key");

    const privateKeyP8 = Buffer.from(encoded, "base64").toString("utf8");
    return { keyId, issuerId, privateKeyP8: privateKeyP8.includes("BEGIN PRIVATE KEY") ? privateKeyP8 : encoded };
  }

  // ── HTTP ────────────────────────────────────────────────────────────

  private async request(method: string, url: string, init: { headers?: Record<string, string>; json?: unknown; body?: string } = {}): Promise<Response> {
    const f = this.opts.fetch ?? fetch;
    const cookie = this.jar.header(url);
    const res = await f(url, {
      method,
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
    this.jar.store(url, res.headers.getSetCookie());
    const text = method === "HEAD" ? "" : await res.text();
    let data: unknown = text;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        // Not JSON (HTML error pages): keep the text.
      }
    }
    return { status: res.status, headers: res.headers, data };
  }
}

/**
 * Maps App Store Connect errors on key creation. The agreement code is Apple's documented one; the other two
 * are matched on the message Apple shows, since their codes are not documented.
 */
function apiKeyError(r: Response): AppleAuthError {
  const errors: { code?: string; title?: string; detail?: string }[] = r.data?.errors ?? [];
  const text = errors.map((e) => `${e.code ?? ""} ${e.title ?? ""} ${e.detail ?? ""}`).join(" ");
  if (/REQUIRED_AGREEMENTS|agreement/i.test(text)) {
    return new AppleAuthError("agreement_required", "Apple requires the Account Holder to accept the latest agreements in App Store Connect (Business) before keys can be created.");
  }
  if (/request access|access.*(api|integrations)|not.*enabled|API_KEY.*(DISABLED|NOT_ALLOWED)/i.test(text)) {
    return new AppleAuthError(
      "api_access_not_enabled",
      "App Store Connect API access isn't enabled for this team. The Account Holder enables it once: App Store Connect → Users and Access → Integrations → App Store Connect API → Request Access.",
    );
  }
  if (r.status === 403) {
    return new AppleAuthError("not_admin", "Your Apple ID can't create API keys for this team: it needs the Admin role (or Account Holder) in App Store Connect.");
  }
  return new AppleAuthError("unexpected", `App Store Connect refused to create an API key (${r.status})${text.trim() ? `: ${text.trim()}` : ""}`);
}
