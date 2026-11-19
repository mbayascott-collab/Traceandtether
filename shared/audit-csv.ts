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

export function auditLogCsv(entries: AuditCsvEntry[]): string {
  const rows: unknown[][] = [
    ["Date and time", "Record", "Record type", "Record ID", "Change", "Account", "Fields"],
    ...entries.map((entry) => [
      entry.createdAt.toISOString(),
      entry.recordLabel,
      humanize(entry.entityType),
      entry.entityId,
      humanize(entry.action),
      entry.actorEmail,
      entry.changedFields.map(humanize).join(", "),
    ]),
  ];

  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}
