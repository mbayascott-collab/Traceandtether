import { createHash } from "node:crypto";

export type StatementImportLine = {
  transactionDate: string;
  flow: "in" | "out";
  amountZmw: string;
  description: string;
  reference: string;
};

export function normalizeStatementText(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function statementLineDuplicateKey(line: StatementImportLine) {
  const cents = BigInt(Math.round(Number(line.amountZmw) * 100));
  return [line.transactionDate, line.flow, cents.toString(), normalizeStatementText(line.reference)].join("|");
}

export function statementImportFingerprint(lines: StatementImportLine[]) {
  const canonicalRows = lines.map((line) => [
    line.transactionDate,
    line.flow,
    BigInt(Math.round(Number(line.amountZmw) * 100)).toString(),
    normalizeStatementText(line.description),
    normalizeStatementText(line.reference),
  ].join("|")).sort();
  return createHash("sha256").update(JSON.stringify(canonicalRows)).digest("hex");
}

export function findDuplicateStatementRows(
  lines: StatementImportLine[],
  existingLines: Array<Pick<StatementImportLine, "transactionDate" | "flow" | "amountZmw" | "reference">>,
) {
  const existingKeys = new Set(existingLines.map((line) => statementLineDuplicateKey({
    ...line,
    description: "",
  })));
  const importedCounts = new Map<string, number>();
  for (const line of lines) {
    const key = statementLineDuplicateKey(line);
    importedCounts.set(key, (importedCounts.get(key) ?? 0) + 1);
  }
  return lines.map((line) => {
    const key = statementLineDuplicateKey(line);
    return existingKeys.has(key) || (importedCounts.get(key) ?? 0) > 1;
  });
}
