import { describe, expect, it } from "vitest";
import { derivePasswordKey, SrpClient } from "../../src/apple/srp.ts";
import { leadingZeroBits, makeHashcash } from "../../src/apple/hashcash.ts";
import { createHash } from "node:crypto";
import vectors from "./srp-vectors.json" with { type: "json" };

const hex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// Vectors from an independent implementation: Python `srp` with rfc5054_enable() and no_username_in_x(),
// SHA-256, 2048-bit group, fixed a and b, and the PBKDF2 password key as the SRP password.
describe("Apple SRP", () => {
  it("derives the s2k and s2k_fo password keys", () => {
    expect(toHex(derivePasswordKey(vectors.password, hex(vectors.salt), vectors.iterations, "s2k"))).toBe(vectors.key_s2k);
    expect(toHex(derivePasswordKey(vectors.password, hex(vectors.salt), vectors.iterations, "s2k_fo"))).toBe(vectors.key_s2k_fo);
    expect(() => derivePasswordKey("x", hex("00"), 1, "s2k_new")).toThrow(/Unsupported/);
  });

  it("matches A, M1 and M2 of the independent implementation", () => {
    const client = new SrpClient(BigInt(`0x${vectors.a}`));
    expect(toHex(client.publicValue)).toBe(vectors.A);
    const { m1, m2 } = client.proof(vectors.account, hex(vectors.key_s2k), hex(vectors.salt), hex(vectors.B));
    expect(toHex(m1)).toBe(vectors.M1);
    expect(toHex(m2)).toBe(vectors.M2);
  });

  it("rejects a zero challenge", () => {
    expect(() => new SrpClient(5n).proof("a", hex("01"), hex("01"), new Uint8Array(1))).toThrow(/Invalid SRP challenge/);
  });
});

describe("hashcash", () => {
  it("has Apple's format and enough leading zero bits", () => {
    const hc = makeHashcash(11, "4d74fb15eb23f465f1f6fcbf534e5877", new Date("2023-02-23T17:06:00Z"));
    expect(hc).toMatch(/^1:11:20230223170600:4d74fb15eb23f465f1f6fcbf534e5877::\d+$/);
    expect(leadingZeroBits(createHash("sha1").update(hc).digest())).toBeGreaterThanOrEqual(11);
  });

  it("counts leading zero bits", () => {
    expect(leadingZeroBits(new Uint8Array([0, 0x10, 0xff]))).toBe(11);
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0, 0]))).toBe(16);
  });
});
