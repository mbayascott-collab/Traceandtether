import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import {
  approvedBusinessRole, createBusinessAccessMiddleware, isPrimaryOwnerEmail,
  isProtectedAccessTarget, normalizeVerifiedEmail, requireAccessManager, resolveBusinessAccount,
} from "./access-control";

function invokeMiddleware(
  middleware: ReturnType<typeof createBusinessAccessMiddleware>,
) {
  let statusCode: number | undefined;
  let body: unknown;
  let nextCalled = false;
  const res = {
    locals: {} as Record<string, unknown>,
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  };
  return Promise.resolve(middleware(
    {} as Request,
    res as unknown as Response,
    (() => { nextCalled = true; }) as never,
  )).then(() => ({ statusCode, body, nextCalled, locals: res.locals }));
}

test("verified active owners and managers can reach business endpoints", async () => {
  for (const [role, email] of [
    ["owner", "owner@example.com"],
    ["manager", "manager@example.com"],
  ] as const) {
    const outcome = await invokeMiddleware(
      createBusinessAccessMiddleware(
        async () => resolveBusinessAccount("user-1", {
          emailAddress: email,
          verification: { status: "verified" },
        }, { email, role, active: true }),
        () => "user-1",
      ),
    );
    assert.equal(outcome.nextCalled, true);
    assert.equal(outcome.statusCode, undefined);
    assert.deepEqual(outcome.locals.actor, {
      clerkUserId: "user-1",
      email,
      role,
    });
  }
});

test("unapproved, unverified, and revoked accounts are denied business access", async () => {
  const cases = [
    {
      name: "unapproved account",
      primaryEmail: { emailAddress: "new@example.com", verification: { status: "verified" } },
      grant: undefined,
    },
    {
      name: "unverified account",
      primaryEmail: { emailAddress: "new@example.com", verification: { status: "unverified" } },
      grant: { email: "new@example.com", role: "manager", active: true },
    },
    {
      name: "revoked account",
      primaryEmail: { emailAddress: "manager@example.com", verification: { status: "verified" } },
      grant: { email: "manager@example.com", role: "manager", active: false },
    },
  ];

  for (const { name, primaryEmail, grant } of cases) {
    const outcome = await invokeMiddleware(
      createBusinessAccessMiddleware(
        async () => resolveBusinessAccount("user-1", primaryEmail, grant),
        () => "user-1",
      ),
    );
    assert.equal(outcome.nextCalled, false, name);
    assert.equal(outcome.statusCode, 403, name);
  }
});

test("unverified addresses and inactive or invalid grants never resolve to business access", () => {
  assert.deepEqual(
    normalizeVerifiedEmail({ emailAddress: "Owner@Example.com", verification: { status: "unverified" } }),
    { email: "Owner@Example.com", reason: "email_not_verified" },
  );
  assert.deepEqual(
    normalizeVerifiedEmail({ emailAddress: " Manager@Example.com ", verification: { status: "verified" } }),
    { email: "manager@example.com" },
  );
  assert.equal(approvedBusinessRole("owner@example.com", {
    email: "owner@example.com", role: "owner", active: true,
  }), "owner");
  assert.equal(approvedBusinessRole("manager@example.com", {
    email: "manager@example.com", role: "manager", active: true,
  }), "manager");
  assert.equal(approvedBusinessRole("manager@example.com", {
    email: "manager@example.com", role: "manager", active: false,
  }), null);
  assert.equal(approvedBusinessRole("manager@example.com", {
    email: "manager@example.com", role: "sales", active: true,
  }), null);
  assert.equal(approvedBusinessRole("manager@example.com", {
    email: "other@example.com", role: "manager", active: true,
  }), null);
  assert.deepEqual(resolveBusinessAccount("user-1", {
    emailAddress: "new@example.com",
    verification: { status: "pending" },
  }, { email: "new@example.com", role: "manager", active: true }), {
    authorized: false, email: "new@example.com", reason: "email_not_verified",
  });
  assert.deepEqual(resolveBusinessAccount("user-1", {
    emailAddress: "manager@example.com",
    verification: { status: "verified" },
  }, { email: "manager@example.com", role: "manager", active: false }), {
    authorized: false, email: "manager@example.com", reason: "email_not_approved",
  });
});

test("only approved owners and managers may grant or revoke access", async () => {
  for (const role of ["owner", "manager"] as const) {
    let nextCalled = false;
    const res = {
      locals: { actor: { role } },
      status(code: number) {
        assert.fail(`Approved ${role} was denied with ${code}`);
        return this;
      },
      json(value: unknown) {
        assert.fail(`Approved ${role} was denied: ${JSON.stringify(value)}`);
        return this;
      },
    };
    requireAccessManager()({} as Request, res as unknown as Response, (() => { nextCalled = true; }) as never);
    assert.equal(nextCalled, true);
  }

  for (const role of ["sales", "reviewer", undefined]) {
    let statusCode: number | undefined;
    let nextCalled = false;
    const res = {
      locals: role ? { actor: { role } } : {},
      status(code: number) {
        statusCode = code;
        return this;
      },
      json() {
        return this;
      },
    };
    requireAccessManager()({} as Request, res as unknown as Response, (() => { nextCalled = true; }) as never);
    assert.equal(statusCode, 403);
    assert.equal(nextCalled, false);
  }
});

test("the primary owner and the current manager cannot be locked out", () => {
  assert.equal(isPrimaryOwnerEmail("OWNER@example.com", "owner@example.com"), true);
  assert.equal(isProtectedAccessTarget("owner@example.com", "manager@example.com", "owner@example.com"), true);
  assert.equal(isProtectedAccessTarget("MANAGER@example.com", "manager@example.com", "owner@example.com"), true);
  assert.equal(isProtectedAccessTarget("another@example.com", "manager@example.com", "owner@example.com"), false);
});
