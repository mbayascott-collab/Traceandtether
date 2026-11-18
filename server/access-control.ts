import type { RequestHandler } from "express";

export type BusinessRole = "owner" | "manager";

export type AccountGrant = {
  email: string;
  role: string;
  active: boolean;
};

export type UserResolution =
  | { authorized: true; actor: { clerkUserId: string; email: string; role: BusinessRole } }
  | {
      authorized: false;
      email: string | null;
      reason: "owner_not_configured" | "email_not_approved" | "email_not_verified";
    };

export function normalizeVerifiedEmail(
  primaryEmail: { emailAddress: string; verification?: { status?: string } | null } | undefined,
): { email: string } | { email: null; reason: "email_not_verified" } {
  if (!primaryEmail || primaryEmail.verification?.status !== "verified") {
    return { email: primaryEmail?.emailAddress ?? null, reason: "email_not_verified" };
  }
  return { email: primaryEmail.emailAddress.trim().toLowerCase() };
}

export function approvedBusinessRole(email: string, grant: AccountGrant | undefined): BusinessRole | null {
  if (!grant || !grant.active || grant.email !== email || (grant.role !== "owner" && grant.role !== "manager")) {
    return null;
  }
  return grant.role;
}

export function resolveBusinessAccount(
  clerkUserId: string,
  primaryEmail: { emailAddress: string; verification?: { status?: string } | null } | undefined,
  grant: AccountGrant | undefined,
): UserResolution {
  const verified = normalizeVerifiedEmail(primaryEmail);
  if ("reason" in verified) {
    return { authorized: false, email: verified.email, reason: verified.reason };
  }
  const role = approvedBusinessRole(verified.email, grant);
  if (!role) {
    return { authorized: false, email: verified.email, reason: "email_not_approved" };
  }
  return {
    authorized: true,
    actor: { clerkUserId, email: verified.email, role },
  };
}

export function isPrimaryOwnerEmail(email: string, configuredOwnerEmail: string | undefined): boolean {
  return Boolean(
    configuredOwnerEmail &&
    email.trim().toLowerCase() === configuredOwnerEmail.trim().toLowerCase(),
  );
}

export function isProtectedAccessTarget(
  targetEmail: string,
  actorEmail: string,
  configuredOwnerEmail: string | undefined,
): boolean {
  const target = targetEmail.trim().toLowerCase();
  return target === actorEmail.trim().toLowerCase() || isPrimaryOwnerEmail(target, configuredOwnerEmail);
}

export function canManageAccess(role: unknown): role is BusinessRole {
  return role === "owner" || role === "manager";
}

export function requireAccessManager(): RequestHandler {
  return (_req, res, next) => {
    const actor = res.locals.actor as { role?: unknown } | undefined;
    if (!canManageAccess(actor?.role)) {
      res.status(403).json({ error: "Only approved business managers can change account access." });
      return;
    }
    next();
  };
}

export function requireBusinessOwner(errorMessage: string): RequestHandler {
  return (_req, res, next) => {
    const actor = res.locals.actor as { role?: unknown } | undefined;
    if (actor?.role !== "owner") {
      res.status(403).json({ error: errorMessage });
      return;
    }
    next();
  };
}

export function createBusinessAccessMiddleware(
  resolveUser: (userId: string) => Promise<UserResolution>,
  getUserId: (req: Parameters<RequestHandler>[0]) => string | null | undefined,
): RequestHandler {
  return async (req, res, next) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Sign in to access the administration area." });
      return;
    }

    try {
      const result = await resolveUser(userId);
      if (!result.authorized) {
        const status = result.reason === "owner_not_configured" ? 503 : 403;
        const message =
          result.reason === "owner_not_configured"
            ? "Owner access is not configured yet."
            : "This verified account is not approved for business access.";
        res.status(status).json({ error: message });
        return;
      }
      res.locals.actor = result.actor;
      next();
    } catch (error) {
      console.error(
        "Unable to verify administrator access.",
        error instanceof Error ? error.name : "UnknownError",
      );
      res.status(503).json({ error: "Business access could not be verified. Try again shortly." });
    }
  };
}
