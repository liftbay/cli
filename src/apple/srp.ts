import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";

/**
 * SRP-6a as Apple's sign-in (GSA) uses it: RFC 5054 2048-bit group, SHA-256, no username in x.
 * Matches fastlane's SIRP gem and EAS (@foxt/js-srp in GSA mode); where those two differ in
 * zero-padding edge cases we follow js-srp, which hashes fixed-width values.
 */

const N = BigInt(
  "0xac6bdb41324a9a9bf166de5e1389582faf72b6651987ee07fc3192943db56050a37329cbb4a099ed8193e0757767a13dd52312ab4b03310dcd7f48a9da04fd50e8083969edb767b0cf6095179a163ab3661a05fbd5faaae82918a9962f0b93b855f97993ec975eeaa80d740adbf4ff747359d041d5c33ea71d281e446b14773bca97b43a23fb801676bd207a436c6481f1d2b9078717461a5b9d32e688f87748544523b524b0d57d5ea77a2775d2ecfa032cfbdbf52fb3786160279004e57ae6af874e7303ce53299ccc041c7bc308d82a5698f3a8d0c38271ae35f8e9dbfbb694b5c803d89f7ae435de236d525f54759b65e372fcd68ef20fa7111f9e4aff73",
);
const g = 2n;
const N_BYTES = 256;

const sha256 = (...parts: Uint8Array[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

/** Big-endian bytes, no leading zeros. */
export function toBytes(n: bigint): Uint8Array {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return new Uint8Array(Buffer.from(hex, "hex"));
}

export const fromBytes = (b: Uint8Array): bigint => (b.length ? BigInt(`0x${Buffer.from(b).toString("hex")}`) : 0n);

/** Left-pads to the width of N. */
function pad(n: bigint): Uint8Array {
  const b = toBytes(n);
  if (b.length >= N_BYTES) return b;
  const out = new Uint8Array(N_BYTES);
  out.set(b, N_BYTES - b.length);
  return out;
}

export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

const k = fromBytes(sha256(toBytes(N), pad(g)));

/**
 * The password key Apple's SRP uses instead of the password: PBKDF2-SHA256 over SHA-256(password).
 * "s2k" feeds the raw digest, the older "s2k_fo" its lowercase hex string (fastlane `pbkdf2`, EAS `calculateProof`).
 */
export function derivePasswordKey(password: string, salt: Uint8Array, iterations: number, protocol: string): Uint8Array {
  if (protocol !== "s2k" && protocol !== "s2k_fo") throw new Error(`Unsupported Apple password protocol "${protocol}"`);
  const digest = createHash("sha256").update(password, "utf8").digest();
  const input = protocol === "s2k_fo" ? Buffer.from(digest.toString("hex"), "utf8") : digest;
  return new Uint8Array(pbkdf2Sync(input, salt, iterations, 32, "sha256"));
}

export class SrpClient {
  readonly a: bigint;
  readonly A: bigint;

  /** `a` is only passed in tests. */
  constructor(a?: bigint) {
    this.a = a ?? fromBytes(new Uint8Array(randomBytes(N_BYTES)));
    this.A = modPow(g, this.a, N);
  }

  /** A, as sent in signin/init (base64 of its big-endian bytes). */
  get publicValue(): Uint8Array {
    return toBytes(this.A);
  }

  /** M1 and M2 for signin/complete, from the server's salt and B and the derived password key. */
  proof(accountName: string, passwordKey: Uint8Array, salt: Uint8Array, serverB: Uint8Array): { m1: Uint8Array; m2: Uint8Array } {
    const B = fromBytes(serverB);
    if (B % N === 0n) throw new Error("Invalid SRP challenge from Apple");
    const u = fromBytes(sha256(pad(this.A), pad(B)));
    if (u === 0n) throw new Error("Invalid SRP challenge from Apple");
    // x = H(salt | H(":" | passwordKey)): GSA leaves the username out.
    const x = fromBytes(sha256(salt, sha256(new Uint8Array([0x3a]), passwordKey)));
    const base = (((B - k * modPow(g, x, N)) % N) + N) % N;
    const S = modPow(base, this.a + u * x, N);
    const K = sha256(toBytes(S));
    const hN = sha256(toBytes(N));
    const hg = sha256(pad(g));
    const xor = hN.map((b, i) => b ^ hg[i]!);
    const m1 = sha256(xor, sha256(Buffer.from(accountName, "utf8")), salt, toBytes(this.A), toBytes(B), K);
    const m2 = sha256(toBytes(this.A), m1, K);
    return { m1, m2 };
  }
}
