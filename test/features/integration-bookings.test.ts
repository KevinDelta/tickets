// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { handleIntegrationBookingRequest } from "#routes/integration-bookings.ts";
import {
  BOOKING_SCOPE,
  operationByKeyInTransaction,
} from "#routes/integration-operations.ts";
import {
  countRows,
  execute,
  queryOne,
  withTransaction,
} from "#shared/db/client.ts";
import { listingsTable } from "#shared/db/listings/records.ts";
import { computeSlugIndex } from "#shared/db/listings/table.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withDbFault } from "#test-utils/db-fault.ts";
import { testListingInput } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";

// jscpd:ignore-end

const INTEGRATION_KEY = "tourbook-integration-key-00000001";
const LISTING_PATH = "/integration/v1/listings/tourbook-integration";

const integrationRequest = (
  path: string,
  options: RequestInit = {},
): Request => {
  const headers = new Headers(options.headers);
  headers.set("authorization", `Bearer ${INTEGRATION_KEY}`);
  return mockRequest(path, { ...options, headers });
};

const resetFixture = (): Promise<Response> =>
  handleRequest(
    integrationRequest("/integration/v1/fixture/reset", { method: "POST" }),
  );

const kernelRequest = async (request: Request): Promise<Response> => {
  const response = await handleIntegrationBookingRequest(
    request,
    new URL(request.url).pathname,
    request.method,
  );
  expect(response).not.toBeNull();
  return response!;
};

const bookingRequest = (
  key: string,
  quantity: number,
  attendee: { email: string; name: string } = {
    email: "traveller@example.com",
    name: "Integration Traveller",
  },
): Request =>
  integrationRequest("/integration/v1/bookings", {
    body: JSON.stringify({
      attendee,
      listingSlug: "tourbook-integration",
      quantity,
    }),
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
    },
    method: "POST",
  });

const createBooking = (key: string, quantity: number): Promise<Response> =>
  kernelRequest(bookingRequest(key, quantity));

const cancellationRequest = (
  bookingId: string,
  key: string,
  quantity: number,
): Request =>
  integrationRequest(`/integration/v1/bookings/${bookingId}/cancellations`, {
    body: JSON.stringify({ quantity }),
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
    },
    method: "POST",
  });

const cancelBooking = (
  bookingId: string,
  key: string,
  quantity: number,
): Promise<Response> =>
  handleRequest(cancellationRequest(bookingId, key, quantity));

const listingEvidence = async (): Promise<Record<string, unknown>> => {
  const response = await kernelRequest(integrationRequest(LISTING_PATH));
  expect(response.status).toBe(200);
  return (await response.json()).listing;
};

describeWithEnv(
  "server integration > Tourbook booking kernel",
  {
    db: true,
    env: {
      TOURBOOK_INTEGRATION_FIXTURE: "true",
      TOURBOOK_INTEGRATION_KEY: INTEGRATION_KEY,
    },
    triggers: true,
  },
  () => {
    test("reads deterministic product-level availability", async () => {
      expect((await resetFixture()).status).toBe(200);
      await listingsTable.insert({
        ...testListingInput({
          maxAttendees: 7,
          maxQuantity: 7,
          name: "Alpha integration",
        }),
        slug: "alpha-integration",
        slugIndex: await computeSlugIndex("alpha-integration"),
      });
      await listingsTable.insert({
        ...testListingInput({ active: false, name: "Hidden integration" }),
        slug: "hidden-integration",
        slugIndex: await computeSlugIndex("hidden-integration"),
      });
      expect(
        await (
          await kernelRequest(integrationRequest("/integration/v1/listings"))
        ).json(),
      ).toEqual({
        listings: [
          {
            availableQuantity: 7,
            bookedQuantity: 0,
            capacity: 7,
            name: "Alpha integration",
            slug: "alpha-integration",
          },
          {
            availableQuantity: 12,
            bookedQuantity: 0,
            capacity: 12,
            name: "Tourbook integration fixture",
            slug: "tourbook-integration",
          },
        ],
      });
      expect(await listingEvidence()).toEqual({
        availableQuantity: 12,
        bookedQuantity: 0,
        capacity: 12,
        name: "Tourbook integration fixture",
        slug: "tourbook-integration",
      });
    });

    test("validates booking identity and material input", async () => {
      expect((await resetFixture()).status).toBe(200);
      const missingKey = await handleRequest(
        integrationRequest("/integration/v1/bookings", {
          body: JSON.stringify({
            attendee: {
              email: "traveller@example.com",
              name: "Integration Traveller",
            },
            listingSlug: "tourbook-integration",
            quantity: 1,
          }),
          method: "POST",
        }),
      );
      expect(missingKey.status).toBe(400);
      expect(await missingKey.json()).toEqual({
        error: "invalid_idempotency_key",
      });

      for (const key of ["", "x".repeat(201)]) {
        const invalidKey = await kernelRequest(bookingRequest(key, 1));
        expect(invalidKey.status).toBe(400);
        expect(await invalidKey.json()).toEqual({
          error: "invalid_idempotency_key",
        });
      }

      expect((await createBooking("x", 1)).status).toBe(201);

      for (const request of [
        bookingRequest("booking-empty-name", 1, {
          email: "traveller@example.com",
          name: "",
        }),
        bookingRequest("booking-zero-quantity", 0),
      ]) {
        const invalidBody = await kernelRequest(request);
        expect(invalidBody.status).toBe(400);
        expect(await invalidBody.json()).toEqual({ error: "invalid_request" });
      }

      const malformed = await handleRequest(
        integrationRequest("/integration/v1/bookings", {
          body: "{",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "booking-malformed",
          },
          method: "POST",
        }),
      );
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({ error: "invalid_request" });
    });

    test("returns 404 for an unknown listing", async () => {
      expect((await resetFixture()).status).toBe(200);
      const response = await handleRequest(
        integrationRequest("/integration/v1/bookings", {
          body: JSON.stringify({
            attendee: {
              email: "traveller@example.com",
              name: "Integration Traveller",
            },
            listingSlug: "missing-listing",
            quantity: 1,
          }),
          headers: {
            "content-type": "application/json",
            "idempotency-key": "booking-missing-listing",
          },
          method: "POST",
        }),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "listing_not_found" });

      const listing = await kernelRequest(
        integrationRequest("/integration/v1/listings/missing-listing"),
      );
      expect(listing.status).toBe(404);
      expect(await listing.json()).toEqual({ error: "listing_not_found" });
    });

    test("reports zero availability for a saturated listing", async () => {
      expect((await resetFixture()).status).toBe(200);
      expect(
        (await createBooking("booking-saturates-listing", 12)).status,
      ).toBe(201);
      expect(await listingEvidence()).toMatchObject({ availableQuantity: 0 });
    });

    test("books the exact requested quantity and records the operation", async () => {
      expect((await resetFixture()).status).toBe(200);
      const response = await createBooking("booking-success", 3);
      expect(response.status).toBe(201);
      const outcome = await response.json();
      expect(outcome.booking).toMatchObject({
        listingSlug: "tourbook-integration",
        quantity: 3,
      });
      expect(outcome.booking.id).toMatch(/^\d+$/);
      expect(outcome.booking.ticketId).toMatch(/^[0-9A-F]{10}$/);
      expect(outcome.booking.ticketUrl).toBe(`/t/${outcome.booking.ticketId}`);
      expect(await listingEvidence()).toMatchObject({
        availableQuantity: 9,
        bookedQuantity: 3,
      });
      expect(await countRows("attendees")).toBe(1);
      expect(await countRows("integration_operations")).toBe(1);
      expect(
        await queryOne<{ quantity: number; scope: string }>(
          "SELECT quantity, scope FROM integration_operations",
        ),
      ).toEqual({ quantity: 3, scope: "integration:booking:create" });
      const stored = await withTransaction((tx) =>
        operationByKeyInTransaction(tx, BOOKING_SCOPE, "booking-success"),
      );
      expect(stored?.idempotency_key).toBe("booking-success");
    });

    test("returns the original result for an identical replay", async () => {
      expect((await resetFixture()).status).toBe(200);
      const first = await createBooking("booking-replay", 2);
      const original = await first.json();
      const replay = await createBooking("booking-replay", 2);
      expect(replay.status).toBe(201);
      expect(await replay.json()).toEqual(original);
      expect(await countRows("attendees")).toBe(1);
      expect(await listingEvidence()).toMatchObject({ bookedQuantity: 2 });
    });

    test("serializes concurrent identical booking retries", async () => {
      expect((await resetFixture()).status).toBe(200);
      const responses = await Promise.all([
        createBooking("booking-concurrent", 4),
        createBooking("booking-concurrent", 4),
      ]);
      expect(responses.map(({ status }) => status)).toEqual([201, 201]);
      const outcomes = await Promise.all(
        responses.map((response) => response.json()),
      );
      expect(outcomes[1]).toEqual(outcomes[0]);
      expect(await countRows("attendees")).toBe(1);
      expect(await listingEvidence()).toMatchObject({ bookedQuantity: 4 });
    });

    test("records the loser of a concurrent capacity race", async () => {
      expect((await resetFixture()).status).toBe(200);
      const responses = await Promise.all([
        createBooking("booking-capacity-race-a", 7),
        createBooking("booking-capacity-race-b", 7),
      ]);
      expect(responses.map(({ status }) => status).toSorted()).toEqual([
        201, 409,
      ]);
      const payloads = await Promise.all(
        responses.map((response) => response.json()),
      );
      expect(
        payloads.some((body) => body.error === "insufficient_capacity"),
      ).toBe(true);
      expect(await countRows("attendees")).toBe(1);
      expect(await countRows("integration_operations")).toBe(2);
      expect(await listingEvidence()).toMatchObject({ bookedQuantity: 7 });
    });

    test("returns 409 when an idempotency key is reused for different input", async () => {
      expect((await resetFixture()).status).toBe(200);
      expect((await createBooking("booking-conflict", 2)).status).toBe(201);
      const conflict = await createBooking("booking-conflict", 3);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({ error: "idempotency_conflict" });
      expect(await countRows("attendees")).toBe(1);
      expect(await listingEvidence()).toMatchObject({ bookedQuantity: 2 });
    });

    test("rejects rather than clamps an insufficient-capacity booking", async () => {
      expect((await resetFixture()).status).toBe(200);
      const response = await createBooking("booking-too-large", 13);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "insufficient_capacity" });
      expect(await countRows("attendees")).toBe(0);
      expect(await countRows("integration_operations")).toBe(1);
      expect(await listingEvidence()).toMatchObject({
        availableQuantity: 12,
        bookedQuantity: 0,
      });
      const replay = await createBooking("booking-too-large", 13);
      expect(replay.status).toBe(409);
      expect(await replay.json()).toEqual({ error: "insufficient_capacity" });
      const conflict = await createBooking("booking-too-large", 12);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({ error: "idempotency_conflict" });
    });

    test("surfaces a booking failure that committed no operation", async () => {
      expect((await resetFixture()).status).toBe(200);
      await execute("DROP TABLE attendees");
      await expect(createBooking("booking-storage-failure", 1)).rejects.toThrow(
        "no such table: attendees",
      );
      expect(await countRows("integration_operations")).toBe(0);
    });

    test("retrieves stable booking and ticket evidence without attendee PII", async () => {
      expect((await resetFixture()).status).toBe(200);
      const created = await createBooking("booking-retrieval", 2);
      const { booking } = await created.json();

      const bookingResult = await handleRequest(
        integrationRequest(`/integration/v1/bookings/${booking.id}`),
      );
      expect(bookingResult.status).toBe(200);
      const bookingPayload = await bookingResult.json();
      expect(bookingPayload).toEqual({
        booking: {
          ...booking,
          cancelledQuantity: 0,
          issuedQuantity: 2,
          remainingQuantity: 2,
          status: "active",
        },
      });

      const ticketResult = await handleRequest(
        integrationRequest(`/integration/v1/tickets/${booking.ticketId}`),
      );
      expect(ticketResult.status).toBe(200);
      expect(await ticketResult.json()).toEqual({
        ticket: {
          bookingId: booking.id,
          cancelledQuantity: 0,
          id: booking.ticketId,
          issuedQuantity: 2,
          listingSlug: "tourbook-integration",
          quantity: 2,
          renderUrl: booking.ticketUrl,
          status: "active",
          valid: true,
        },
      });
      expect(JSON.stringify(bookingPayload)).not.toContain(
        "traveller@example.com",
      );
    });

    test("fixture reset removes booking, ticket, and operation evidence", async () => {
      expect((await resetFixture()).status).toBe(200);
      const created = await createBooking("booking-reset", 1);
      const { booking } = await created.json();
      expect((await resetFixture()).status).toBe(200);

      const missingBooking = await handleRequest(
        integrationRequest(`/integration/v1/bookings/${booking.id}`),
      );
      expect(missingBooking.status).toBe(404);
      expect(await missingBooking.json()).toEqual({
        error: "booking_not_found",
      });
      const missingTicket = await handleRequest(
        integrationRequest(`/integration/v1/tickets/${booking.ticketId}`),
      );
      expect(missingTicket.status).toBe(404);
      expect(await missingTicket.json()).toEqual({ error: "ticket_not_found" });
      expect(await countRows("integration_operations")).toBe(0);
      expect(await listingEvidence()).toMatchObject({
        availableQuantity: 12,
        bookedQuantity: 0,
      });
    });

    test("does not route unknown POST paths into booking creation", async () => {
      expect((await resetFixture()).status).toBe(200);
      const response = await handleRequest(
        integrationRequest("/integration/v1/unknown", { method: "POST" }),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
      expect(await countRows("attendees")).toBe(0);
    });

    test("partially cancels an exact quantity and updates every read", async () => {
      expect((await resetFixture()).status).toBe(200);
      const created = await createBooking("booking-partial-cancel", 3);
      const { booking } = await created.json();
      const response = await cancelBooking(
        booking.id,
        "cancellation-partial",
        2,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        cancellation: {
          affectedQuantity: 2,
          bookingId: booking.id,
          cancelledQuantity: 2,
          issuedQuantity: 3,
          remainingQuantity: 1,
          status: "partially_cancelled",
        },
      });
      expect(await listingEvidence()).toMatchObject({
        availableQuantity: 11,
        bookedQuantity: 1,
      });
      expect(
        await queryOne<{ scope: string }>(
          "SELECT scope FROM integration_operations WHERE idempotency_key = ?",
          ["cancellation-partial"],
        ),
      ).toEqual({ scope: "integration:booking:cancel" });

      const bookingRead = await handleRequest(
        integrationRequest(`/integration/v1/bookings/${booking.id}`),
      );
      expect(await bookingRead.json()).toMatchObject({
        booking: {
          cancelledQuantity: 2,
          issuedQuantity: 3,
          remainingQuantity: 1,
          status: "partially_cancelled",
        },
      });
      const ticketRead = await handleRequest(
        integrationRequest(`/integration/v1/tickets/${booking.ticketId}`),
      );
      expect(await ticketRead.json()).toMatchObject({
        ticket: {
          cancelledQuantity: 2,
          quantity: 1,
          status: "partially_cancelled",
          valid: true,
        },
      });
      const cancellationRead = await handleRequest(
        integrationRequest(
          `/integration/v1/bookings/${booking.id}/cancellations`,
        ),
      );
      expect(await cancellationRead.json()).toEqual({
        cancellation: {
          bookingId: booking.id,
          cancelledQuantity: 2,
          issuedQuantity: 3,
          remainingQuantity: 1,
          status: "partially_cancelled",
        },
      });
    });

    test("composes partial cancellations into a fully revoked ticket", async () => {
      expect((await resetFixture()).status).toBe(200);
      const { booking } = await (
        await createBooking("booking-full-cancel", 5)
      ).json();
      expect(
        (await cancelBooking(booking.id, "cancellation-first", 2)).status,
      ).toBe(200);
      const final = await cancelBooking(booking.id, "cancellation-final", 3);
      expect(final.status).toBe(200);
      expect(await final.json()).toEqual({
        cancellation: {
          affectedQuantity: 3,
          bookingId: booking.id,
          cancelledQuantity: 5,
          issuedQuantity: 5,
          remainingQuantity: 0,
          status: "cancelled",
        },
      });
      expect(await listingEvidence()).toMatchObject({
        availableQuantity: 12,
        bookedQuantity: 0,
      });
      const ticket = await handleRequest(
        integrationRequest(`/integration/v1/tickets/${booking.ticketId}`),
      );
      expect(await ticket.json()).toMatchObject({
        ticket: { quantity: 0, status: "cancelled", valid: false },
      });
    });

    test("replays one cancellation and conflicts on changed input", async () => {
      expect((await resetFixture()).status).toBe(200);
      const { booking } = await (
        await createBooking("booking-cancel-replay", 4)
      ).json();
      const first = await cancelBooking(booking.id, "cancellation-replay", 2);
      const original = await first.json();
      const replay = await cancelBooking(booking.id, "cancellation-replay", 2);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(original);
      const conflict = await cancelBooking(
        booking.id,
        "cancellation-replay",
        1,
      );
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({ error: "idempotency_conflict" });
      expect(await countRows("integration_operations")).toBe(2);
      expect(await listingEvidence()).toMatchObject({ bookedQuantity: 2 });
    });

    test("serializes concurrent identical cancellation retries", async () => {
      expect((await resetFixture()).status).toBe(200);
      const { booking } = await (
        await createBooking("booking-cancel-concurrent", 4)
      ).json();
      const responses = await Promise.all([
        cancelBooking(booking.id, "cancellation-concurrent", 2),
        cancelBooking(booking.id, "cancellation-concurrent", 2),
      ]);
      expect(responses.map(({ status }) => status)).toEqual([200, 200]);
      const outcomes = await Promise.all(
        responses.map((response) => response.json()),
      );
      expect(outcomes[1]).toEqual(outcomes[0]);
      expect(await listingEvidence()).toMatchObject({ bookedQuantity: 2 });
    });

    test("durably rejects over-cancellation without revoking tickets", async () => {
      expect((await resetFixture()).status).toBe(200);
      const { booking } = await (
        await createBooking("booking-over-cancel", 2)
      ).json();
      const response = await cancelBooking(
        booking.id,
        "cancellation-too-large",
        3,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        cancellation: {
          affectedQuantity: 0,
          bookingId: booking.id,
          cancelledQuantity: 0,
          issuedQuantity: 2,
          remainingQuantity: 2,
          status: "active",
        },
        error: "cancellation_exceeds_remaining_quantity",
      });
      expect(
        (await cancelBooking(booking.id, "cancellation-too-large", 3)).status,
      ).toBe(409);
      const conflict = await cancelBooking(
        booking.id,
        "cancellation-too-large",
        2,
      );
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({ error: "idempotency_conflict" });
      expect(await listingEvidence()).toMatchObject({ bookedQuantity: 2 });
    });

    test("rolls back when the exact cancellation update is refused", async () => {
      expect((await resetFixture()).status).toBe(200);
      const { booking } = await (
        await createBooking("booking-cancel-update-fault", 2)
      ).json();
      await withDbFault(
        `CREATE TRIGGER test_cancellation_update_fault
          BEFORE UPDATE OF quantity ON listing_attendees
          BEGIN
            SELECT RAISE(IGNORE);
          END`,
        "test_cancellation_update_fault",
        async () => {
          await expect(
            cancelBooking(booking.id, "cancellation-update-fault", 1),
          ).rejects.toThrow();
        },
      );
      expect(await listingEvidence()).toMatchObject({ bookedQuantity: 2 });
      expect(await countRows("integration_operations")).toBe(1);
    });

    test("validates cancellation input and clears its state on reset", async () => {
      expect((await resetFixture()).status).toBe(200);
      const { booking } = await (
        await createBooking("booking-cancel-reset", 2)
      ).json();
      expect(
        (await handleRequest(cancellationRequest(booking.id, "", 1))).status,
      ).toBe(400);
      expect(
        (
          await handleRequest(
            cancellationRequest(booking.id, "cancellation-zero", 0),
          )
        ).status,
      ).toBe(400);
      const missing = await cancelBooking("999999", "cancellation-missing", 1);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "booking_not_found" });
      expect(
        (await cancelBooking(booking.id, "cancellation-before-reset", 1))
          .status,
      ).toBe(200);
      expect((await resetFixture()).status).toBe(200);
      const status = await handleRequest(
        integrationRequest(
          `/integration/v1/bookings/${booking.id}/cancellations`,
        ),
      );
      expect(status.status).toBe(404);
      expect(await status.json()).toEqual({ error: "booking_not_found" });
      expect(await countRows("integration_operations")).toBe(0);
    });

    test("does not expose payment-refund authority", async () => {
      expect((await resetFixture()).status).toBe(200);
      const response = await handleRequest(
        integrationRequest("/integration/v1/refunds", { method: "POST" }),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    });
  },
);
