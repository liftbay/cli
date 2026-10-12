import { createPublicKey, verify } from "node:crypto";
import forge from "node-forge";
import { describe, expect, it } from "vitest";
import { generateSigningCertificate, signDraft } from "../src/commands/signing.ts";

describe("update signing keys", () => {
  const generated = generateSigningCertificate("acme");
  const cert = forge.pki.certificateFromPem(generated.certificatePem);

  it("makes a certificate expo-updates accepts", () => {
    expect(cert.issuer.hash).toBe(cert.subject.hash);
    expect(cert.verify(cert)).toBe(true);
    expect((cert.getExtension("keyUsage") as { digitalSignature?: boolean }).digitalSignature).toBe(true);
    expect((cert.getExtension("extKeyUsage") as { codeSigning?: boolean }).codeSigning).toBe(true);
    expect(cert.validity.notAfter.getTime() - Date.now()).toBeGreaterThan(9 * 365 * 86_400_000);
    expect((cert.publicKey as forge.pki.rsa.PublicKey).n.bitLength()).toBe(2048);
  });

  it("signs each draft item so the certificate verifies it", () => {
    const items = [
      { id: "ios:expo-manifest", data: Buffer.from('{"id":"x"}').toString("base64") },
      { id: "ios:hot-updater", data: Buffer.alloc(32, 7).toString("base64") },
    ];
    const sigs = signDraft(items, generated.privateKeyPem);
    for (const i of items) {
      expect(verify("sha256", Buffer.from(i.data, "base64"), createPublicKey(generated.certificatePem), Buffer.from(sigs[i.id]!, "base64"))).toBe(true);
    }
  });
});
