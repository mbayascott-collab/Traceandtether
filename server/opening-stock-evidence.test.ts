import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectOpeningStockEvidence, MAX_OPENING_STOCK_EVIDENCE_BYTES, MAX_OPENING_STOCK_EVIDENCE_FILES,
  parseOpeningStockEvidenceMultipart, safeOpeningStockEvidenceFilename,
} from "./opening-stock-evidence";
import { createZipArchive } from "./zip-archive";

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

test("download filenames preserve saved names while removing paths and unsafe header characters", () => {
  assert.equal(safeOpeningStockEvidenceFilename("../count-sheet.pdf"), "count-sheet.pdf");
  assert.equal(safeOpeningStockEvidenceFilename("C:\\counts\\Révisé.pdf"), "Révisé.pdf");
  assert.equal(safeOpeningStockEvidenceFilename('bad"\r\nname.pdf'), "badname.pdf");
  assert.equal(safeOpeningStockEvidenceFilename(".."), "count-evidence");
});

test("opening-stock multipart upload keeps all count fields and evidence files together", () => {
  const boundary = "count-boundary";
  const body = Buffer.from([
    `--${boundary}\r\nContent-Disposition: form-data; name="productId"\r\n\r\n12`,
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="memo"\r\n\r\nOpening count`,
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="evidence"; filename="signed-count.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-worksheet`,
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="evidence"; filename="stock-photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\nphoto-bytes`,
    `\r\n--${boundary}--\r\n`,
  ].join(""));
  const parsed = parseOpeningStockEvidenceMultipart(body, `multipart/form-data; boundary=${boundary}`);

  assert.ok(!("error" in parsed));
  if ("error" in parsed) return;
  assert.deepEqual({ ...parsed.fields }, { productId: "12", memo: "Opening count" });
  assert.deepEqual(parsed.files.map(({ fileName, data }) => [fileName, data.toString()]), [
    ["signed-count.pdf", "%PDF-worksheet"],
    ["stock-photo.jpg", "photo-bytes"],
  ]);
});

test("opening-stock multipart upload rejects malformed bodies and too many files", () => {
  assert.ok("error" in parseOpeningStockEvidenceMultipart(Buffer.from("bad"), "multipart/form-data; boundary=count"));

  const boundary = "count-boundary";
  const parts = Array.from({ length: MAX_OPENING_STOCK_EVIDENCE_FILES + 1 }, (_, index) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="evidence"; filename="file-${index}.pdf"\r\n\r\n%PDF-${index}\r\n`,
  ).join("");
  const body = Buffer.from(`${parts}--${boundary}--\r\n`);
  const parsed = parseOpeningStockEvidenceMultipart(body, `multipart/form-data; boundary=${boundary}`);
  assert.ok("error" in parsed);
  if ("error" in parsed) assert.match(parsed.error ?? "", /no more than/);
});

test("count evidence ZIP archives preserve saved names and exact file bytes", () => {
  const entries = [
    { fileName: "count-sheet.pdf", data: Buffer.from("%PDF-original worksheet") },
    { fileName: "Révisé-stock-photo.webp", data: Buffer.from([0, 255, 17, 0, 32]) },
  ];
  const archive = createZipArchive(entries);
  const endOffset = archive.length - 22;
  assert.equal(archive.readUInt32LE(endOffset), 0x06054b50);
  assert.equal(archive.readUInt16LE(endOffset + 10), entries.length);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  let cursor = centralOffset;

  entries.forEach((expected) => {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    const checksum = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const fileNameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const fileName = archive.subarray(cursor + 46, cursor + 46 + fileNameLength).toString("utf8");
    assert.equal(fileName, expected.fileName);

    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const fileData = archive.subarray(dataOffset, dataOffset + compressedSize);
    assert.deepEqual(fileData, expected.data);
    assert.equal(checksum, crc32ForTest(fileData));
    cursor += 46 + fileNameLength + extraLength + commentLength;
  });
});

function crc32ForTest(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
