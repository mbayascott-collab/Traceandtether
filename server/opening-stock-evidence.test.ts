import assert from "node:assert/strict";
import test from "node:test";
import { inspectOpeningStockEvidence, MAX_OPENING_STOCK_EVIDENCE_BYTES } from "./opening-stock-evidence";

test("opening-stock evidence accepts supported worksheet and photo types", () => {
  assert.equal(inspectOpeningStockEvidence(Buffer.from("%PDF-1.7 worksheet"), "count.pdf").mimeType, "application/pdf");
  assert.equal(inspectOpeningStockEvidence(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), "count.png").mimeType, "image/png");
  assert.equal(inspectOpeningStockEvidence(Buffer.from([0xff, 0xd8, 0xff]), "count.jpg").mimeType, "image/jpeg");
  assert.equal(inspectOpeningStockEvidence(Buffer.from("RIFF0000WEBP"), "count.webp").mimeType, "image/webp");
});

test("opening-stock evidence rejects empty, oversized, and unsupported files", () => {
  assert.equal(inspectOpeningStockEvidence(Buffer.alloc(0), "empty.pdf").error, "Choose a count worksheet or photo.");
  assert.equal(
    inspectOpeningStockEvidence(Buffer.alloc(MAX_OPENING_STOCK_EVIDENCE_BYTES + 1), "large.pdf").error,
    "The count worksheet or photo must be 5 MB or smaller.",
  );
  assert.match(inspectOpeningStockEvidence(Buffer.from("not a pdf"), "fake.pdf").error ?? "", /PDF, JPEG, PNG, or WebP/);
});

test("opening-stock evidence strips paths and unsafe filename characters", () => {
  assert.equal(inspectOpeningStockEvidence(Buffer.from("%PDF-1.7"), '../count"\n-sheet.pdf').fileName, "count-sheet.pdf");
});
