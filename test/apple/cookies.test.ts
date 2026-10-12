import { describe, expect, it } from "vitest";
import { CookieJar } from "../../src/apple/cookies.ts";

describe("cookie jar", () => {
  it("matches domains, paths and expiry", () => {
    const jar = new CookieJar();
    const now = Date.parse("2026-10-06T00:00:00Z");
    jar.store(
      "https://idmsa.apple.com/appleauth/auth/signin/complete",
      [
        "myacinfo=abc; Domain=.apple.com; Path=/; Secure; HttpOnly",
        'DES5c148586dfd451e55afb0175f62418f91="HSARMTKNSRVXWFla==SRVX"; Domain=idmsa.apple.com; Path=/; Max-Age=2592000; Secure',
        "aasp=1; Path=/appleauth",
        "old=1; Domain=apple.com; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        "other=1; Domain=example.com",
      ],
      now,
    );
    expect(jar.header("https://appstoreconnect.apple.com/olympus/v1/session", now)).toBe("myacinfo=abc");
    const idmsa = jar.header("https://idmsa.apple.com/appleauth/auth", now);
    expect(idmsa).toContain('DES5c148586dfd451e55afb0175f62418f91="HSARMTKNSRVXWFla==SRVX"');
    expect(idmsa).toContain("aasp=1");
    expect(idmsa).not.toContain("old=");
    expect(idmsa).not.toContain("other=");
    expect(jar.header("https://idmsa.apple.com/appleauthx", now)).not.toContain("aasp");
    expect(jar.header("http://appstoreconnect.apple.com/", now)).toBe("");
    // Max-Age expiry, and survival through JSON.
    const restored = new CookieJar(JSON.parse(JSON.stringify(jar)));
    expect(restored.header("https://idmsa.apple.com/", now + 2592001_000)).not.toContain("DES");
    expect(restored.get("myacinfo")).toBe("abc");
  });

  it("replaces a cookie with the same name, domain and path", () => {
    const jar = new CookieJar();
    jar.store("https://idmsa.apple.com/", ["a=1; Path=/"]);
    jar.store("https://idmsa.apple.com/", ["a=2; Path=/"]);
    expect(jar.header("https://idmsa.apple.com/")).toBe("a=2");
  });
});
