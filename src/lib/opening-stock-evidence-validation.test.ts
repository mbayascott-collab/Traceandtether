import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_OPENING_STOCK_EVIDENCE_BYTES,
  MAX_OPENING_STOCK_EVIDENCE_FILES,
  openingStockEvidenceErrors,
} from "./api";

const file = (name: string, size: number) => ({ name, size }) as File;

test("opening-stock evidence accepts five files at the per-file size limit", () => {
  const evidence = Array.from({ length: MAX_OPENING_STOCK_EVIDENCE_FILES }, (_, index) =>
    file(`count-${index + 1}.pdf`, MAX_OPENING_STOCK_EVIDENCE_BYTES));
  assert.deepEqual(openingStockEvidenceErrors(evidence), []);
});

test("opening-stock evidence identifies oversized files and selections over five files", () => {
  const evidence = [
    ...Array.from({ length: MAX_OPENING_STOCK_EVIDENCE_FILES }, (_, index) => file(`count-${index + 1}.pdf`, 1)),
    file("extra.pdf", 1),
    file("large.pdf", MAX_OPENING_STOCK_EVIDENCE_BYTES + 1),
  ];
  assert.deepEqual(openingStockEvidenceErrors(evidence), [
    "Choose no more than 5 count files.",
    "large.pdf is larger than 5 MB.",
  ]);
});
