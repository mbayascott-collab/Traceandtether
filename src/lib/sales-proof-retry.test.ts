import assert from "node:assert/strict";
import test from "node:test";
import { clearSalesProofRetryKey, getSalesProofRetryKey } from "./sales-proof-retry";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

const file = { name: "signed.pdf", size: 256, type: "application/pdf", lastModified: 1000 };

test("proof retries reuse the request key after the upload form is reopened", () => {
  const session = storage();
  const first = getSalesProofRetryKey(session, 12, file, () => "7c1a2510-3706-4bd8-9a2c-25b5fa70f684");
  const afterRefresh = getSalesProofRetryKey(session, 12, file, () => {
    throw new Error("A retry should reuse its saved request key.");
  });
  assert.equal(afterRefresh, first);
});

test("different deliveries or file versions get separate keys, and successful uploads clear the old key", () => {
  const session = storage();
  let next = 0;
  const createKey = () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
  const first = getSalesProofRetryKey(session, 12, file, createKey);
  assert.notEqual(getSalesProofRetryKey(session, 13, file, createKey), first);
  assert.notEqual(getSalesProofRetryKey(session, 12, { ...file, lastModified: 2000 }, createKey), first);
  clearSalesProofRetryKey(session, 12, file);
  assert.notEqual(getSalesProofRetryKey(session, 12, file, createKey), first);
});
