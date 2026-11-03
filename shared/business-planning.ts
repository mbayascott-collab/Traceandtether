export function suggestedReorderQuantity(onHand: number, reserved: number, incoming: number, reorderLevel: number) {
  const available = Math.max(0, onHand - reserved);
  const stockPosition = available + Math.max(0, incoming);
  return Math.max(0, reorderLevel - stockPosition);
}

export function forecastCashWithin30Days(recordedCash: bigint, receivablesBalance: bigint, payablesBalance: bigint) {
  const expectedReceipts = receivablesBalance > 0n ? receivablesBalance : 0n;
  const expectedPayments = payablesBalance < 0n ? -payablesBalance : 0n;
  return {
    recordedCash,
    expectedReceipts,
    expectedPayments,
    estimatedClosing: recordedCash + expectedReceipts - expectedPayments,
  };
}
