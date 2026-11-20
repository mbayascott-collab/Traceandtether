export type AuditCsvEntry = {
  createdAt: Date;
  recordLabel: string;
  entityType: string;
  entityId: number;
  action: string;
  actorEmail: string;
  changedFields: string[];
};

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  const safe = /^[\s\uFEFF]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

export function auditLogCsvHeader(): string {
  return ["Date and time", "Record", "Record type", "Record ID", "Change", "Account", "Fields"]
    .map(csvCell)
    .join(",");
}

export function auditLogCsvRow(entry: AuditCsvEntry): string {
  return [
    entry.createdAt.toISOString(),
    entry.recordLabel,
    humanize(entry.entityType),
    entry.entityId,
    humanize(entry.action),
    entry.actorEmail,
    entry.changedFields.map(humanize).join(", "),
  ].map(csvCell).join(",");
}

export function auditLogCsv(entries: AuditCsvEntry[]): string {
  return `\uFEFF${[auditLogCsvHeader(), ...entries.map(auditLogCsvRow)].join("\r\n")}`;
}
