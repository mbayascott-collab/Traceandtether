import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import test from "node:test";
import { eq, inArray } from "drizzle-orm";
import { appUserAccess, appUsers } from "../shared/schema";

test("Clerk first sign-in provisions only the configured verified owner", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { clerkClient }, { resolveUser, registerApiRoutes }, { createBusinessAccessMiddleware }] = await Promise.all([
    import("./db"),
    import("@clerk/express"),
    import("./routes"),
    import("./access-control"),
  ]);
  const tables = await pool.query(
    "SELECT to_regclass('public.app_user_access') IS NOT NULL AS access, to_regclass('public.app_users') IS NOT NULL AS users",
  );
  if (!tables.rows[0]?.access || !tables.rows[0]?.users) {
    t.skip("requires the user access database migration");
    await pool.end();
    return;
  }

  const suffix = randomUUID();
  const ownerEmail = `owner-${suffix}@example.test`;
  const ownerSecondaryEmail = `owner-secondary-${suffix}@example.test`;
  const unverifiedEmail = `unverified-${suffix}@example.test`;
  const configuredEmail = `configured-${suffix}@example.test`;
  const secondaryOnlyPrimaryEmail = `secondary-only-primary-${suffix}@example.test`;
  const managerEmail = `manager-${suffix}@example.test`;
  const ownerUserId = `first-owner-${suffix}`;
  const unverifiedUserId = `unverified-owner-${suffix}`;
  const secondaryOnlyUserId = `secondary-only-owner-${suffix}`;
  const managerUserId = `other-account-${suffix}`;
  const clerkUsers = new Map([
    [ownerUserId, {
      id: ownerUserId,
      primaryEmailAddressId: "owner-primary",
      emailAddresses: [{
        id: "owner-secondary",
        emailAddress: ownerSecondaryEmail,
        verification: { status: "verified" },
      }, {
        id: "owner-primary",
        emailAddress: ownerEmail.toUpperCase(),
        verification: { status: "verified" },
      }],
    }],
    [unverifiedUserId, {
      id: unverifiedUserId,
      primaryEmailAddressId: "unverified-primary",
      emailAddresses: [{
        id: "unverified-primary",
        emailAddress: unverifiedEmail,
        verification: { status: "unverified" },
      }],
    }],
    [secondaryOnlyUserId, {
      id: secondaryOnlyUserId,
      primaryEmailAddressId: "secondary-only-primary",
      emailAddresses: [{
        id: "secondary-only-primary",
        emailAddress: secondaryOnlyPrimaryEmail,
        verification: { status: "verified" },
      }, {
        id: "configured-secondary",
        emailAddress: configuredEmail,
        verification: { status: "verified" },
      }],
    }],
    [managerUserId, {
      id: managerUserId,
      primaryEmailAddressId: "manager-primary",
      emailAddresses: [{
        id: "manager-primary",
        emailAddress: managerEmail,
        verification: { status: "verified" },
      }],
    }],
  ]);
  const previousOwnerEmail = process.env.INITIAL_ADMIN_EMAIL;
  const userIds = [ownerUserId, unverifiedUserId, secondaryOnlyUserId, managerUserId];
  const emails = [
    ownerEmail, ownerSecondaryEmail, unverifiedEmail, configuredEmail,
    secondaryOnlyPrimaryEmail, managerEmail,
  ];

  t.mock.method(clerkClient.users, "getUser", async (userId: string) => {
    const clerkUser = clerkUsers.get(userId);
    assert.ok(clerkUser, `unexpected Clerk user lookup: ${userId}`);
    return clerkUser as never;
  });

  const app = express();
  app.use(express.json());
  const businessAccess = createBusinessAccessMiddleware(resolveUser, () => ownerUserId);
  registerApiRoutes(app, businessAccess, () => ownerUserId);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const currentUserUrl = `http://127.0.0.1:${address.port}/api/me`;
  const accessUrl = `http://127.0.0.1:${address.port}/api/user-access`;
  const originalInsert = db.insert.bind(db);
  let failOwnerGrantInsert = true;
  t.mock.method(db, "insert", (table: any) => {
    if (table === appUserAccess && failOwnerGrantInsert) {
      failOwnerGrantInsert = false;
      throw new Error("temporary database error");
    }
    return originalInsert(table);
  });

  try {
    // A temporary provisioning failure must be retryable from the signed-in current-user endpoint.
    process.env.INITIAL_ADMIN_EMAIL = ` ${ownerEmail.toUpperCase()} `;
    const failedResponse = await fetch(currentUserUrl);
    assert.equal(failedResponse.status, 503);
    assert.deepEqual(await failedResponse.json(), {
      error: "Account access could not be checked. Try again shortly.",
    });
    assert.equal((await db.select().from(appUserAccess)
      .where(eq(appUserAccess.email, ownerEmail))).length, 0);
    assert.equal((await db.select().from(appUsers)
      .where(eq(appUsers.clerkUserId, ownerUserId))).length, 0);

    const retryResponse = await fetch(currentUserUrl);
    assert.equal(retryResponse.status, 200);
    assert.deepEqual(await retryResponse.json(), {
      authorized: true,
      email: ownerEmail,
      role: "owner",
    });

    const accessResponse = await fetch(accessUrl);
    assert.equal(accessResponse.status, 200);
    const accessPayload = await accessResponse.json() as { users: Array<{ email: string; role: string }> };
    assert.equal(accessPayload.users.filter((user) => user.email === ownerEmail && user.role === "owner").length, 1);

    // A verified configured owner keeps access on repeat sign-in without another grant.
    const firstOwnerSignIn = await resolveUser(ownerUserId);
    assert.deepEqual(firstOwnerSignIn, {
      authorized: true,
      actor: { clerkUserId: ownerUserId, email: ownerEmail, role: "owner" },
    });
    assert.deepEqual(await resolveUser(ownerUserId), firstOwnerSignIn);

    const [ownerGrant] = await db.select().from(appUserAccess)
      .where(eq(appUserAccess.email, ownerEmail));
    assert.equal(ownerGrant?.role, "owner");
    assert.equal(ownerGrant?.active, true);
    const ownerGrants = await db.select().from(appUserAccess)
      .where(eq(appUserAccess.email, ownerEmail));
    assert.equal(ownerGrants.length, 1, "repeat sign-in must not create another owner grant");
    const ownerRecords = await db.select().from(appUsers)
      .where(eq(appUsers.clerkUserId, ownerUserId));
    assert.equal(ownerRecords.length, 1);
    assert.equal(ownerRecords[0]?.role, "owner");
    assert.equal((await db.select().from(appUserAccess)
      .where(eq(appUserAccess.email, ownerSecondaryEmail))).length, 0,
    "a verified secondary address must not receive a separate owner grant");

    // A configured owner address found only as a secondary email does not grant owner access.
    process.env.INITIAL_ADMIN_EMAIL = configuredEmail;
    assert.deepEqual(await resolveUser(secondaryOnlyUserId), {
      authorized: false,
      email: secondaryOnlyPrimaryEmail,
      reason: "email_not_approved",
    });
    assert.equal((await db.select().from(appUserAccess)
      .where(eq(appUserAccess.email, configuredEmail))).length, 0);
    assert.equal((await db.select().from(appUsers)
      .where(eq(appUsers.clerkUserId, secondaryOnlyUserId))).length, 0);

    // An unverified Clerk primary address cannot create either access record.
    process.env.INITIAL_ADMIN_EMAIL = unverifiedEmail;
    assert.deepEqual(await resolveUser(unverifiedUserId), {
      authorized: false,
      email: unverifiedEmail,
      reason: "email_not_verified",
    });
    assert.equal((await db.select().from(appUserAccess)
      .where(eq(appUserAccess.email, unverifiedEmail))).length, 0);
    assert.equal((await db.select().from(appUsers)
      .where(eq(appUsers.clerkUserId, unverifiedUserId))).length, 0);

    // A verified address that differs from configuration remains a manager, not an owner.
    await db.insert(appUserAccess).values({
      email: managerEmail,
      role: "manager",
      active: true,
    });
    process.env.INITIAL_ADMIN_EMAIL = configuredEmail;
    const otherAccountSignIn = await resolveUser(managerUserId);
    assert.deepEqual(otherAccountSignIn, {
      authorized: true,
      actor: { clerkUserId: managerUserId, email: managerEmail, role: "manager" },
    });
    const [managerGrant] = await db.select().from(appUserAccess)
      .where(eq(appUserAccess.email, managerEmail));
    assert.equal(managerGrant?.role, "manager");
    const managerRecords = await db.select().from(appUsers)
      .where(eq(appUsers.clerkUserId, managerUserId));
    assert.equal(managerRecords[0]?.role, "manager");
  } finally {
    if (previousOwnerEmail === undefined) delete process.env.INITIAL_ADMIN_EMAIL;
    else process.env.INITIAL_ADMIN_EMAIL = previousOwnerEmail;
    await db.delete(appUsers).where(inArray(appUsers.clerkUserId, userIds));
    await db.delete(appUserAccess).where(inArray(appUserAccess.email, emails));
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await pool.end();
  }
});
