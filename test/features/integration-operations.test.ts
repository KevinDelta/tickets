import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  fingerprintMaterial,
  idempotencyKeyFrom,
  PositiveQuantitySchema,
} from "#routes/integration-operations.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import "./integration-bookings.test.ts";

test("accepts only bounded non-empty idempotency keys", () => {
  const request = (key: string): Request =>
    mockRequest("/integration/v1/bookings", {
      headers: { "idempotency-key": key },
    });
  expect(idempotencyKeyFrom(request("x"))).toBe("x");
  expect(idempotencyKeyFrom(request(""))).toBeNull();
  expect(idempotencyKeyFrom(request("x".repeat(201)))).toBeNull();
});

test("validates positive safe quantities", () => {
  expect(v.parse(PositiveQuantitySchema, 1)).toBe(1);
  expect(() => v.parse(PositiveQuantitySchema, 0)).toThrow();
  expect(() => v.parse(PositiveQuantitySchema, 1.5)).toThrow();
});

test("fingerprints ordered material deterministically", async () => {
  const first = await fingerprintMaterial(["booking", 2]);
  expect(await fingerprintMaterial(["booking", 2])).toBe(first);
  expect(await fingerprintMaterial(["booking", 3])).not.toBe(first);
});
