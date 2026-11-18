import { businessAuditLogs } from "../shared/schema";

export type AuditActor = { clerkUserId: string; email: string } | { clerkUserId: null; email: string };

export async function recordBusinessAudit(
  tx: any,
  input: {
    entityType: string;
    entityId: number;
    recordLabel: string;
    actor: AuditActor;
    action: "created" | "updated" | "deleted";
    changedFields?: string[];
  },
) {
  await tx.insert(businessAuditLogs).values({
    entityType: input.entityType,
    entityId: input.entityId,
    recordLabel: input.recordLabel.slice(0, 240),
    actorClerkUserId: input.actor.clerkUserId,
    actorEmail: input.actor.email.slice(0, 320),
    action: input.action,
    changedFields: input.changedFields ?? [],
  });
}
