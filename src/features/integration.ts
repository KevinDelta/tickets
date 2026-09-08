/** Authenticated integration routes for the Tourbook service boundary. */

/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { lazyRef } from "#fp";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { jsonResponse } from "#routes/response.ts";
import { constantTimeEqual } from "#shared/crypto/utils.ts";

/* jscpd:ignore-end */

const INTEGRATION_PREFIX = "/integration/";
/** Fixed freshness so live Tourbook fixture digests stay deterministic. */
const FIXTURE_LOCATION_UPDATED_AT = "2026-09-06T12:00:00.000Z";

const FIXTURE_LISTINGS = [
  {
    capacity: 12,
    kernelLocation: {
      latitude: 57.14774,
      longitude: -2.096323,
      updatedAt: FIXTURE_LOCATION_UPDATED_AT,
    },
    name: "Tourbook integration fixture",
    slug: "tourbook-integration",
  },
  {
    capacity: 8,
    name: "Tourbook soft-channel fixture",
    slug: "tourbook-soft-channel",
  },
] as const;
const KeySchema = v.pipe(
  v.string(),
  v.minLength(
    32,
    "TOURBOOK_INTEGRATION_KEY must contain at least 32 characters",
  ),
);
const FixtureModeSchema = v.picklist(["false", "true"]);

const [getFixturePublicKey] = lazyRef<Promise<string>>(async () => {
  const { generateKeyPair } = await import("#shared/crypto/keys.ts");
  return (await generateKeyPair()).publicKey;
});

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
  const [
    { listingsTable },
    { computeSlugIndex },
    migrations,
    { execute },
    { settingUpsert },
    { CONFIG_KEYS },
  ] = await Promise.all([
    import("#shared/db/listings/records.ts"),
    import("#shared/db/listings/table.ts"),
    import("#shared/db/migrations.ts"),
    import("#shared/db/client.ts"),
    import("#shared/db/settings/raw-writes.ts"),
    import("#shared/settings/keys.ts"),
  ]);
  const { rebuildWipedSchema, resetDatabase } = migrations;
  await resetDatabase();
  await rebuildWipedSchema();
  const publicKey = settingUpsert(
    CONFIG_KEYS.PUBLIC_KEY,
    await getFixturePublicKey(),
  );
  await execute(publicKey.sql, publicKey.args);
  for (const listing of FIXTURE_LISTINGS) {
    await listingsTable.insert({
      active: true,
      ...("kernelLocation" in listing
        ? { kernelLocation: listing.kernelLocation }
        : {}),
      maxAttendees: listing.capacity,
      maxPrice: 0,
      maxQuantity: listing.capacity,
      name: listing.name,
      slug: listing.slug,
      slugIndex: await computeSlugIndex(listing.slug),
    });
  }
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
    listings: FIXTURE_LISTINGS.map(({ capacity, slug }) => ({
      capacity,
      slug,
    })),
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

  if (method === "GET" && path === "/integration/v1/health") {
    const { initDb } = await import("#shared/db/migrations.ts");
    await initDb({ allowMissingSettings: true });
    return jsonResponse({ status: "ready" });
  }
  if (method === "POST" && path === "/integration/v1/fixture/reset") {
    return await resetResponse();
  }
  const { handleIntegrationBookingRequest } = await import(
    "#routes/integration-bookings.ts"
  );
  const bookingResponse = await handleIntegrationBookingRequest(
    request,
    path,
    method,
  );
  if (bookingResponse !== null) return bookingResponse;
  const { handleIntegrationCancellationRequest } = await import(
    "#routes/integration-cancellations.ts"
  );
  return (
    (await handleIntegrationCancellationRequest(request, path, method)) ??
    apiErrorResponse("not_found", 404)
  );
};
