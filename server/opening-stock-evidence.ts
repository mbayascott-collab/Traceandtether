export const MAX_OPENING_STOCK_EVIDENCE_BYTES = 5 * 1024 * 1024;
export const MAX_OPENING_STOCK_EVIDENCE_FILES = 5;

export interface OpeningStockEvidenceUpload {
  fileName: string;
  data: Buffer;
}

export function parseOpeningStockEvidenceMultipart(body: Buffer, contentType: string) {
  const boundaryMatch = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary || boundary.length > 200) return { error: "The count evidence upload is invalid." } as const;

  const boundaryStart = Buffer.from(`--${boundary}\r\n`);
  if (!body.subarray(0, boundaryStart.length).equals(boundaryStart)) {
    return { error: "The count evidence upload is invalid." } as const;
  }

  const boundaryMarker = Buffer.from(`\r\n--${boundary}`);
  const fields: Record<string, string> = Object.create(null);
  const files: OpeningStockEvidenceUpload[] = [];
  let cursor = boundaryStart.length;
  while (cursor < body.length) {
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), cursor);
    if (headerEnd < 0) return { error: "The count evidence upload is invalid." } as const;
    const headers = body.subarray(cursor, headerEnd).toString("latin1");
    const disposition = /^content-disposition:\s*form-data;(.*)$/im.exec(headers)?.[1];
    const name = disposition && /(?:^|;)\s*name="((?:\\.|[^"])*)"/i.exec(disposition)?.[1]
      .replace(/\\(.)/g, "$1");
    if (!name) return { error: "The count evidence upload is invalid." } as const;
    const filenameMatch = disposition && /(?:^|;)\s*filename="((?:\\.|[^"])*)"/i.exec(disposition);
    const dataStart = headerEnd + 4;
    const partEnd = body.indexOf(boundaryMarker, dataStart);
    if (partEnd < 0) return { error: "The count evidence upload is invalid." } as const;
    const data = body.subarray(dataStart, partEnd);

    if (filenameMatch) {
      if (name !== "evidence") return { error: "Only count evidence files can be uploaded here." } as const;
      files.push({
        fileName: filenameMatch[1].replace(/\\(.)/g, "$1"),
        data: Buffer.from(data),
      });
      if (files.length > MAX_OPENING_STOCK_EVIDENCE_FILES) {
        return { error: `Attach no more than ${MAX_OPENING_STOCK_EVIDENCE_FILES} count files.` } as const;
      }
    } else {
      if (Object.hasOwn(fields, name)) return { error: "The count details contain a duplicate field." } as const;
      fields[name] = data.toString("utf8");
    }

    const suffixStart = partEnd + boundaryMarker.length;
    const suffix = body.subarray(suffixStart, suffixStart + 2).toString("ascii");
    if (suffix === "--") {
      const trailing = body.subarray(suffixStart + 2);
      if (trailing.length !== 0 && !trailing.equals(Buffer.from("\r\n"))) {
        return { error: "The count evidence upload is invalid." } as const;
      }
      return { fields, files } as const;
    }
    if (suffix !== "\r\n") return { error: "The count evidence upload is invalid." } as const;
    cursor = suffixStart + 2;
  }
  return { error: "The count evidence upload is invalid." } as const;
}

export function inspectOpeningStockEvidence(file: Buffer, originalName: string) {
  if (file.length === 0) return { error: "Choose a count worksheet or photo." } as const;
  if (file.length > MAX_OPENING_STOCK_EVIDENCE_BYTES) {
    return { error: "The count worksheet or photo must be 5 MB or smaller." } as const;
  }

  let mimeType: string | null = null;
  if (file.subarray(0, 5).toString("ascii") === "%PDF-") mimeType = "application/pdf";
  else if (file.length >= 8 && file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mimeType = "image/png";
  else if (file.length >= 3 && file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff) mimeType = "image/jpeg";
  else if (file.length >= 12 && file.subarray(0, 4).toString("ascii") === "RIFF" && file.subarray(8, 12).toString("ascii") === "WEBP") mimeType = "image/webp";

  if (!mimeType) return { error: "Upload a PDF, JPEG, PNG, or WebP count worksheet or photo." } as const;

  const leafName = originalName.split(/[\\/]/).pop() ?? "";
  const safeName = leafName.replace(/[\u0000-\u001f\u007f"]/g, "").trim().slice(0, 255);
  return {
    fileName: safeName || `opening-stock-evidence.${mimeType === "application/pdf" ? "pdf" : mimeType.slice(6)}`,
    mimeType,
  } as const;
}
