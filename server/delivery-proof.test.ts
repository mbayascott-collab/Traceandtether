import test from "node:test";
import assert from "node:assert/strict";
import { MAX_DELIVERY_PROOF_BYTES, inspectDeliveryProof } from "./delivery-proof";

test("delivery proof accepts supported files based on their content", () => {
  const pdf = Buffer.from("%PDF-1.7 signed proof");
  assert.deepEqual(inspectDeliveryProof(pdf, "signed.pdf"), {
    fileName: "signed.pdf",
    mimeType: "application/pdf",
  });

  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  assert.equal(inspectDeliveryProof(png, "proof.png").mimeType, "image/png");
  assert.equal(inspectDeliveryProof(Buffer.from([0xff, 0xd8, 0xff, 0]), "proof.jpg").mimeType, "image/jpeg");
  assert.equal(inspectDeliveryProof(Buffer.from("RIFF0000WEBP"), "proof.webp").mimeType, "image/webp");
});

test("delivery proof rejects empty, oversized, and unsupported content", () => {
  assert.equal(inspectDeliveryProof(Buffer.alloc(0), "empty.pdf").error, "Choose a signed proof file.");
  assert.equal(
    inspectDeliveryProof(Buffer.alloc(MAX_DELIVERY_PROOF_BYTES + 1), "large.pdf").error,
    "The signed proof must be 5 MB or smaller.",
  );
  assert.match(inspectDeliveryProof(Buffer.from("not a pdf"), "spoofed.pdf").error ?? "", /PDF, JPEG, PNG, or WebP/);
});

test("delivery proof filenames cannot inject paths or response headers", () => {
  const result = inspectDeliveryProof(Buffer.from("%PDF-1.7"), '../signed"\nproof.pdf');
  assert.equal(result.fileName, "signedproof.pdf");
});
