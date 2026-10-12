/** A minimal cookie jar for Apple's auth hosts: domain and path matching, expiry, JSON round trip. */

export type StoredCookie = { name: string; value: string; domain: string; hostOnly: boolean; path: string; secure: boolean; expires: number | null };

export class CookieJar {
  private cookies: StoredCookie[] = [];

  constructor(saved: StoredCookie[] = []) {
    this.cookies = saved.filter((c) => !isExpired(c));
  }

  /** Stores every Set-Cookie of a response from `url`. */
  store(url: string, setCookies: string[], now = Date.now()) {
    const { hostname, pathname } = new URL(url);
    for (const header of setCookies) {
      const c = parse(header, hostname, pathname, now);
      if (!c || !domainMatches(hostname, c)) continue;
      this.cookies = this.cookies.filter((o) => !(o.name === c.name && o.domain === c.domain && o.path === c.path));
      if (!isExpired(c, now)) this.cookies.push(c);
    }
  }

  /** The Cookie header for a request to `url`, or "" when none apply. */
  header(url: string, now = Date.now()): string {
    const { hostname, pathname, protocol } = new URL(url);
    return this.cookies
      .filter((c) => !isExpired(c, now) && domainMatches(hostname, c) && pathMatches(pathname, c.path) && (!c.secure || protocol === "https:"))
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  get(name: string): string | undefined {
    return this.cookies.find((c) => c.name === name)?.value;
  }

  toJSON(): StoredCookie[] {
    return this.cookies.filter((c) => !isExpired(c));
  }
}

const isExpired = (c: StoredCookie, now = Date.now()) => c.expires !== null && c.expires <= now;

function domainMatches(host: string, c: StoredCookie): boolean {
  if (c.hostOnly) return host === c.domain;
  return host === c.domain || host.endsWith(`.${c.domain}`);
}

function pathMatches(reqPath: string, cookiePath: string): boolean {
  if (reqPath === cookiePath) return true;
  if (!reqPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || reqPath[cookiePath.length] === "/";
}

function defaultPath(pathname: string): string {
  const i = pathname.lastIndexOf("/");
  return i <= 0 ? "/" : pathname.slice(0, i);
}

/**
 * The value is kept exactly as sent, quotes included: Apple's DES… cookie is quoted, and fastlane has to
 * re-add the quotes its jar strips before signing in again.
 */
function parse(header: string, host: string, pathname: string, now: number): StoredCookie | null {
  const [pair, ...attrs] = header.split(";");
  const eq = pair?.indexOf("=") ?? -1;
  if (!pair || eq <= 0) return null;
  const c: StoredCookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: host, hostOnly: true, path: defaultPath(pathname), secure: false, expires: null };
  let maxAge: number | null = null;
  for (const attr of attrs) {
    const i = attr.indexOf("=");
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? "" : attr.slice(i + 1).trim();
    if (key === "domain" && val) {
      c.domain = val.replace(/^\./, "").toLowerCase();
      c.hostOnly = false;
    } else if (key === "path" && val.startsWith("/")) c.path = val;
    else if (key === "secure") c.secure = true;
    else if (key === "max-age" && /^-?\d+$/.test(val)) maxAge = Number(val);
    else if (key === "expires") {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) c.expires = t;
    }
  }
  if (maxAge !== null) c.expires = now + maxAge * 1000;
  return c;
}
