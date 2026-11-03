import assert from "node:assert/strict";
import test from "node:test";
import { databaseErrorStatus } from "./database-errors";

test("maps PostgreSQL constraint failures wrapped by Drizzle", () => {
  const wrapped = { cause: { code: "23505" } };
  assert.deepEqual(databaseErrorStatus(wrapped, "Duplicate supplier."), {
    status: 409,
    message: "Duplicate supplier.",
  });
  assert.deepEqual(databaseErrorStatus({ cause: { code: "23514" } }), {
    status: 400,
    message: "One or more values are outside the allowed range.",
  });
});
