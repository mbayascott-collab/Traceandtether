import assert from "node:assert/strict";
import test from "node:test";
import { processDeliveryProofUploads, type DeliveryProofUpload } from "./delivery-proof-upload";

test("proof upload progress records each result and retries only failed files", async () => {
  const files = [
    { file: { name: "one.pdf" }, idempotencyKey: "one", status: "pending" as const },
    { file: { name: "two.pdf" }, idempotencyKey: "two", status: "pending" as const },
    { file: { name: "three.pdf" }, idempotencyKey: "three", status: "pending" as const },
  ];
  const calls: string[] = [];
  let failTwo = true;
  const upload = async (item: DeliveryProofUpload<{ name: string }>) => {
    calls.push(item.idempotencyKey);
    if (item.idempotencyKey === "two" && failTwo) {
      throw new Error("The file could not be saved.");
    }
    return { id: item.idempotencyKey };
  };
  const progress: string[] = [];
  const first = await processDeliveryProofUploads(files, upload, (items) => {
    progress.push(items.map((item) => item.status).join(","));
  });

  assert.deepEqual(first.uploads.map((item) => item.status), ["saved", "failed", "saved"]);
  assert.deepEqual(first.failed.map((item) => item.file.name), ["two.pdf"]);
  assert.deepEqual(first.saved.map((proof) => proof.id), ["one", "three"]);
  assert.ok(progress.includes("uploading,pending,pending"));
  assert.ok(progress.includes("saved,uploading,pending"));

  failTwo = false;
  const retry = await processDeliveryProofUploads(first.uploads, upload, () => {});
  assert.deepEqual(retry.uploads.map((item) => item.status), ["saved", "saved", "saved"]);
  assert.deepEqual(calls, ["one", "two", "three", "two"], "completed files must not be uploaded a second time.");
});

test("a failed upload remains retryable with its original request key", async () => {
  const requestKey = "stable-request-key";
  const item = { file: { name: "receipt.pdf" }, idempotencyKey: requestKey, status: "failed" as const };
  let retriedKey = "";
  const result = await processDeliveryProofUploads([item], async (upload) => {
    retriedKey = upload.idempotencyKey;
    return "saved";
  }, () => {});

  assert.equal(retriedKey, requestKey);
  assert.equal(result.uploads[0]?.status, "saved");
});
