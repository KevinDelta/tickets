/** Authenticated integration routes for the Tourbook service boundary. */

/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { lazyRef } from "#fp";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { jsonResponse } from "#routes/response.ts";
import { constantTimeEqual } from "#shared/crypto/utils.ts";

/* jscpd:ignore-end */

const INTEGRATION_PREFIX = "/integration/";
const FIXTURE_CAPACITY = 12;
const FIXTURE_SLUG = "tourbook-integration";
const KeySchema = v.pipe(
  v.string(),
  v.minLength(
    32,
    "TOURBOOK_INTEGRATION_KEY must contain at least 32 characters",
  ),
);
const FixtureModeSchema = v.picklist(["false", "true"]);

const integrationKey = (): string | undefined => {
  const value = Deno.env.get("TOURBOOK_INTEGRATION_KEY");
  return value === undefined ? undefined : v.parse(KeySchema, value);
};

const fixtureModeEnabled = (): boolean => {
  const value = Deno.env.get("TOURBOOK_INTEGRATION_FIXTURE");
  return value === undefined
    ? false
    : v.parse(FixtureModeSchema, value) === "true";
};

const authorizationError = (
  request: Request,
  expected: string,
): Response | null => {
  const authorization = request.headers.get("authorization");
  if (authorization === null) {
    return apiErrorResponse("authentication_required", 401);
  }
  if (!authorization.startsWith("Bearer ")) {
    return apiErrorResponse("forbidden", 403);
  }
  return constantTimeEqual(authorization.slice(7), expected)
    ? null
    : apiErrorResponse("forbidden", 403);
};

const resetFixture = async (): Promise<void> => {
  const [{ listingsTable }, { computeSlugIndex }, migrations] =
    await Promise.all([
      import("#shared/db/listings/records.ts"),
      import("#shared/db/listings/table.ts"),
      import("#shared/db/migrations.ts"),
    ]);
  const { rebuildWipedSchema, resetDatabase } = migrations;
  await resetDatabase();
  await rebuildWipedSchema();
  await listingsTable.insert({
    active: true,
    maxAttendees: FIXTURE_CAPACITY,
    maxPrice: 0,
    maxQuantity: FIXTURE_CAPACITY,
    name: "Tourbook integration fixture",
    slug: FIXTURE_SLUG,
    slugIndex: await computeSlugIndex(FIXTURE_SLUG),
  });
};

const [getResetQueue, setResetQueue] = lazyRef<Promise<void>>(() =>
  Promise.resolve(),
);

const queueFixtureReset = async (): Promise<void> => {
  const previous = getResetQueue();
  const gate = Promise.withResolvers<void>();
  setResetQueue(gate.promise);
  await previous;
  try {
    await resetFixture();
  } finally {
    gate.resolve();
  }
};

const resetResponse = async (): Promise<Response> => {
  if (!fixtureModeEnabled()) return apiErrorResponse("not_found", 404);
  await queueFixtureReset();
  return jsonResponse({
    listing: { capacity: FIXTURE_CAPACITY, slug: FIXTURE_SLUG },
    status: "reset",
  });
};

/** Whether this path belongs to the isolated integration route space. */
export const isIntegrationPath = (path: string): boolean =>
  path.startsWith(INTEGRATION_PREFIX);

/** Authenticate and handle one isolated Tourbook integration request. */
export const handleIntegrationRequest = async (
  request: Request,
  path: string,
  method: string,
): Promise<Response> => {
  const key = integrationKey();
  if (key === undefined) return apiErrorResponse("not_found", 404);
  const authError = authorizationError(request, key);
  if (authError) return authError;

  const isHealth = method === "GET" && path === "/integration/v1/health";
  const isReset = method === "POST" && path === "/integration/v1/fixture/reset";
  if (!isHealth && !isReset) return apiErrorResponse("not_found", 404);

  if (isHealth) {
    const { initDb } = await import("#shared/db/migrations.ts");
    await initDb({ allowMissingSettings: true });
    return jsonResponse({ status: "ready" });
  }
  return await resetResponse();
};
