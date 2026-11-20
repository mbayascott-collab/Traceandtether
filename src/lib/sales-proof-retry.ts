export interface ProofRetryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storageKey(deliveryId: number, file: Pick<File, "name" | "size" | "type" | "lastModified">) {
  const fingerprint = JSON.stringify([file.name, file.size, file.type, file.lastModified]);
  return `sales-delivery-proof-retry:${deliveryId}:${encodeURIComponent(fingerprint)}`;
}

export function getSalesProofRetryKey(
  storage: ProofRetryStorage,
  deliveryId: number,
  file: Pick<File, "name" | "size" | "type" | "lastModified">,
  createKey: () => string,
) {
  const key = storageKey(deliveryId, file);
  const saved = storage.getItem(key);
  if (saved && /^[0-9a-f-]{36}$/i.test(saved)) return saved;
  const idempotencyKey = createKey();
  storage.setItem(key, idempotencyKey);
  return idempotencyKey;
}

export function clearSalesProofRetryKey(
  storage: ProofRetryStorage,
  deliveryId: number,
  file: Pick<File, "name" | "size" | "type" | "lastModified">,
) {
  storage.removeItem(storageKey(deliveryId, file));
}
