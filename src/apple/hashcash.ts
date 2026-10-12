import { createHash } from "node:crypto";

/**
 * Apple's proof of work for sign-in (X-Apple-HC): "1:bits:YYYYMMDDHHMMSS:challenge::counter" whose SHA-1
 * starts with `bits` zero bits. Not standard hashcash: no random part and a decimal counter
 * (fastlane spaceship/hashcash.rb, EAS makeHashcash; the date is UTC as in EAS).
 */
export function makeHashcash(bits: number, challenge: string, date = new Date()): string {
  const stamp = date.toISOString().slice(0, 19).replace(/[-:T]/g, "");
  for (let counter = 0; ; counter++) {
    const hc = `1:${bits}:${stamp}:${challenge}::${counter}`;
    if (leadingZeroBits(createHash("sha1").update(hc).digest()) >= bits) return hc;
  }
}

export function leadingZeroBits(digest: Uint8Array): number {
  let n = 0;
  for (const byte of digest) {
    if (byte === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(byte) - 24;
  }
  return n;
}
