// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { isIntegrationPath } from "#routes/integration.ts";
import { getDb, queryOne } from "#shared/db/client.ts";
import { getAllListings } from "#shared/db/listings/records.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { expectStaticFile } from "#test-utils/public/static-route-checks.ts";

// jscpd:ignore-end

const INTEGRATION_KEY = "tourbook-integration-key-00000001";
const RESET_PATH = "/integration/v1/fixture/reset";

const authorizedRequest = (path: string, method = "GET"): Request =>
  mockRequest(path, {
    headers: { authorization: `Bearer ${INTEGRATION_KEY}` },
    method,
  });

const resetFixture = (): Promise<Response> =>
  handleRequest(authorizedRequest(RESET_PATH, "POST"));

const expectFixtureState = async (): Promise<void> => {
  const listings = await getAllListings();
  expect(listings).toHaveLength(2);
  expect(listings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        active: true,
        attendee_count: 0,
        date: "",
        max_attendees: 12,
        max_price: 0,
        name: "Tourbook integration fixture",
        slug: "tourbook-integration",
        tickets_count: 0,
      }),
      expect.objectContaining({
        active: true,
        attendee_count: 0,
        date: "",
        max_attendees: 8,
        max_price: 0,
        name: "Tourbook soft-channel fixture",
        slug: "tourbook-soft-channel",
        tickets_count: 0,
      }),
    ]),
  );
  expect(
    await queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM attendees",
    ),
  ).toEqual({ count: 0 });
};

describeWithEnv(
  "server integration > Tourbook fixture",
  {
    db: true,
    env: {
      TOURBOOK_INTEGRATION_FIXTURE: "true",
      TOURBOOK_INTEGRATION_KEY: INTEGRATION_KEY,
    },
    triggers: true,
  },
  () => {
    test("recognizes only the integration route space", () => {
      expect(isIntegrationPath("/integration/v1/health")).toBe(true);
      expect(isIntegrationPath("/ticket/tourbook-integration")).toBe(false);
    });

    test("keeps the public health route unchanged", async () => {
      await expectStaticFile("/health", "text/plain; charset=utf-8", (body) =>
        expect(body).toBe("Up :)"),
      );
    });

    test("rejects a missing credential", async () => {
      const response = await handleRequest(
        mockRequest("/integration/v1/health"),
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: "authentication_required",
      });
    });

    test("rejects an invalid credential", async () => {
      const response = await handleRequest(
        mockRequest("/integration/v1/health", {
          headers: { authorization: "Bearer invalid-integration-key" },
        }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    });

    test("rejects a malformed authorization scheme", async () => {
      const response = await handleRequest(
        mockRequest("/integration/v1/health", {
          headers: { authorization: INTEGRATION_KEY },
        }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    });

    test("rejects a scheme that hides a valid key after seven characters", async () => {
      const response = await handleRequest(
        mockRequest("/integration/v1/health", {
          headers: { authorization: `Invalid${INTEGRATION_KEY}` },
        }),
      );
      expect(response.status).toBe(403);
    });

    test("reports readiness without exposing attendee data", async () => {
      const response = await handleRequest(
        authorizedRequest("/integration/v1/health"),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(await response.json()).toEqual({ status: "ready" });
    });

    test("initializes an empty isolated database for readiness", async () => {
      const { resetDatabase } = await import("#shared/db/migrations.ts");
      await resetDatabase();
      const response = await handleRequest(
        authorizedRequest("/integration/v1/health"),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ready" });
    });

    test("resets to two deterministic date-less listings", async () => {
      const response = await resetFixture();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        listings: [
          { capacity: 12, slug: "tourbook-integration" },
          { capacity: 8, slug: "tourbook-soft-channel" },
        ],
        status: "reset",
      });
      await expectFixtureState();
    });

    test("converges after sequential resets", async () => {
      expect((await resetFixture()).status).toBe(200);
      expect((await resetFixture()).status).toBe(200);
      await expectFixtureState();
    });

    test("serializes concurrent resets", async () => {
      const responses = await Promise.all([resetFixture(), resetFixture()]);
      expect(responses.map(({ status }) => status)).toEqual([200, 200]);
      await expectFixtureState();
    });

    test("reports a failed reset and retries the complete reset", async () => {
      {
        using _failure = stub(getDb(), "executeMultiple", () =>
          Promise.reject(new Error("fixture rebuild failed")),
        );
        await expect(resetFixture()).rejects.toThrow("fixture rebuild failed");
      }
      expect((await resetFixture()).status).toBe(200);
      await expectFixtureState();
    });

    test("returns 404 for an unknown integration operation", async () => {
      const response = await handleRequest(
        authorizedRequest("/integration/v1/unknown"),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    });

    test("returns 404 for an unknown POST operation", async () => {
      const response = await handleRequest(
        authorizedRequest("/integration/v1/unknown", "POST"),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    });

    test("fails loudly for an invalid fixture mode", async () => {
      using _env = withEnv({ TOURBOOK_INTEGRATION_FIXTURE: "sometimes" });
      await expect(resetFixture()).rejects.toThrow("Invalid type");
    });

    test("fails loudly for a short configured key", async () => {
      using _env = withEnv({ TOURBOOK_INTEGRATION_KEY: "short" });
      await expect(
        handleRequest(mockRequest("/integration/v1/health")),
      ).rejects.toThrow(
        "TOURBOOK_INTEGRATION_KEY must contain at least 32 characters",
      );
    });
  },
);

describeWithEnv(
  "server integration > disabled Tourbook fixture",
  { db: true, triggers: true },
  () => {
    test("hides integration routes when the key is not configured", async () => {
      const response = await handleRequest(
        mockRequest("/integration/v1/health"),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    });

    test("hides reset when fixture mode is absent", async () => {
      using _env = withEnv({ TOURBOOK_INTEGRATION_KEY: INTEGRATION_KEY });
      const response = await resetFixture();
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    });

    test("hides reset when fixture mode is false", async () => {
      using _env = withEnv({
        TOURBOOK_INTEGRATION_FIXTURE: "false",
        TOURBOOK_INTEGRATION_KEY: INTEGRATION_KEY,
      });
      const response = await resetFixture();
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    });
  },
);
