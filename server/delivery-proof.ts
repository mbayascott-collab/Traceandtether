export const MAX_DELIVERY_PROOF_BYTES = 5 * 1024 * 1024;

const supportedMimeTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

export function inspectDeliveryProof(file: Buffer, originalName: string) {
  if (file.length === 0) return { error: "Choose a signed proof file." } as const;
  if (file.length > MAX_DELIVERY_PROOF_BYTES) {
    return { error: "The signed proof must be 5 MB or smaller." } as const;
  }

  let mimeType: string | null = null;
  if (file.subarray(0, 5).toString("ascii") === "%PDF-") mimeType = "application/pdf";
  else if (file.length >= 8 && file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mimeType = "image/png";
  else if (file.length >= 3 && file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff) mimeType = "image/jpeg";
  else if (file.length >= 12 && file.subarray(0, 4).toString("ascii") === "RIFF" && file.subarray(8, 12).toString("ascii") === "WEBP") mimeType = "image/webp";

  if (!mimeType || !supportedMimeTypes.has(mimeType)) {
    return { error: "Upload a PDF, JPEG, PNG, or WebP signed proof." } as const;
  }

  const leafName = originalName.split(/[\\/]/).pop() ?? "";
  const safeName = leafName
    .replace(/[\u0000-\u001f\u007f"]/g, "")
    .trim()
    .slice(0, 255);

  return { fileName: safeName || `delivery-proof.${mimeType === "application/pdf" ? "pdf" : mimeType.slice(6)}`, mimeType } as const;
}
