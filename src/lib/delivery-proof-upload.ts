export type DeliveryProofUploadStatus = "pending" | "uploading" | "saved" | "failed";

export interface DeliveryProofUpload<FileType = File> {
  file: FileType;
  idempotencyKey: string;
  status: DeliveryProofUploadStatus;
  error?: string;
}

export interface DeliveryProofUploadFailure<FileType = File> {
  file: FileType;
  error: string;
}

export async function processDeliveryProofUploads<FileType, Proof>(
  uploads: readonly DeliveryProofUpload<FileType>[],
  upload: (item: DeliveryProofUpload<FileType>) => Promise<Proof>,
  onProgress: (uploads: DeliveryProofUpload<FileType>[]) => void,
): Promise<{
  uploads: DeliveryProofUpload<FileType>[];
  saved: Proof[];
  failed: DeliveryProofUploadFailure<FileType>[];
}> {
  const current = uploads.map((item) => ({ ...item }));
  const saved: Proof[] = [];

  for (let index = 0; index < current.length; index += 1) {
    const item = current[index]!;
    if (item.status === "saved") continue;

    current[index] = { ...item, status: "uploading", error: undefined };
    onProgress(current.map((entry) => ({ ...entry })));
    try {
      saved.push(await upload(current[index]!));
      current[index] = { ...current[index]!, status: "saved", error: undefined };
    } catch (cause) {
      current[index] = {
        ...current[index]!,
        status: "failed",
        error: cause instanceof Error ? cause.message : "Upload failed.",
      };
    }
    onProgress(current.map((entry) => ({ ...entry })));
  }

  return {
    uploads: current,
    saved,
    failed: current.flatMap((item) => item.status === "failed"
      ? [{ file: item.file, error: item.error ?? "Upload failed." }]
      : []),
  };
}
