/** PII-minimized booking operations for the authenticated integration boundary. */

/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { jsonResponse } from "#routes/response.ts";
import { generateTicketToken, toBase64Url } from "#shared/crypto/utils.ts";
import { createAttendeeAtomicImpl } from "#shared/db/attendees/create.ts";
import {
  execute,
  insert,
  queryOne,
  type SqlStatement,
} from "#shared/db/client.ts";
import { getListingWithCountBySlug } from "#shared/db/listings/records.ts";
import { settings } from "#shared/db/settings.ts";
import { nowIso } from "#shared/now.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";

/* jscpd:ignore-end */

const BOOKING_SCOPE = "integration:booking:create";
const IDEMPOTENCY_KEY_MAX_LENGTH = 200;
const ShortTextSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(200));

const BookingRequestSchema = v.object({
  attendee: v.object({
    email: v.pipe(v.string(), v.email()),
    name: ShortTextSchema,
  }),
  listingSlug: ShortTextSchema,
  quantity: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

type BookingRequest = v.InferOutput<typeof BookingRequestSchema>;
type BookingDetails = {
  id: string;
  listingSlug: string;
  quantity: number;
  ticketId: string;
  ticketUrl: string;
};
type BookingEvidence = { booking: BookingDetails };
type StoredOperation = {
  booking_id: number | null;
  idempotency_key: string;
  listing_slug: string;
  outcome_json: string;
  quantity: number;
  request_fingerprint: string;
  status_code: number;
  ticket_id: string | null;
};

const operationByKey = (key: string): Promise<StoredOperation | null> =>
  queryOne<StoredOperation>(
    `SELECT booking_id, idempotency_key, listing_slug, outcome_json, quantity,
            request_fingerprint, status_code, ticket_id
       FROM integration_operations
      WHERE scope = ? AND idempotency_key = ?`,
    [BOOKING_SCOPE, key],
  );

const fingerprintRequest = async (request: BookingRequest): Promise<string> => {
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      request.listingSlug,
      request.quantity,
      request.attendee.name,
      request.attendee.email,
    ]),
  );
  return toBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  );
};

const storedResponse = (operation: StoredOperation): Response =>
  jsonResponse(JSON.parse(operation.outcome_json), operation.status_code);

const replayResponse = (
  operation: StoredOperation,
  fingerprint: string,
): Response =>
  operation.request_fingerprint === fingerprint
    ? storedResponse(operation)
    : apiErrorResponse("idempotency_conflict", 409);

const reconcileFailure = async (
  key: string,
  fingerprint: string,
  run: () => Promise<Response>,
): Promise<Response> => {
  try {
    return await run();
  } catch (error) {
    return await operationResponseOrThrow(error, key, fingerprint);
  }
};

const operationInsert = (
  key: string,
  fingerprint: string,
  request: Pick<BookingRequest, "listingSlug" | "quantity">,
  outcome: unknown,
  statusCode: number,
  bookingId: number | null,
  ticketId: string | null,
): SqlStatement =>
  insert("integration_operations", {
    booking_id: bookingId,
    created_at: nowIso(),
    idempotency_key: key,
    listing_slug: request.listingSlug,
    outcome_json: JSON.stringify(outcome),
    quantity: request.quantity,
    request_fingerprint: fingerprint,
    scope: BOOKING_SCOPE,
    status_code: statusCode,
    ticket_id: ticketId,
  });

const operationResponseOrThrow = async (
  error: unknown,
  key: string,
  fingerprint: string,
): Promise<Response> => {
  const operation = await operationByKey(key);
  if (operation !== null) return replayResponse(operation, fingerprint);
  throw error;
};

const committedResponse = async (
  key: string,
  fingerprint: string,
): Promise<Response> =>
  await operationResponseOrThrow(
    new Error("Committed integration operation is missing"),
    key,
    fingerprint,
  );

const recordRejectedBooking = async (
  key: string,
  fingerprint: string,
  request: BookingRequest,
): Promise<Response> => {
  const outcome = { error: "insufficient_capacity" };
  return await reconcileFailure(key, fingerprint, async () => {
    const statement = operationInsert(
      key,
      fingerprint,
      request,
      outcome,
      409,
      null,
      null,
    );
    await execute(statement.sql, statement.args);
    return await committedResponse(key, fingerprint);
  });
};

const availableQuantity = (listing: {
  attendee_count: number;
  max_attendees: number;
  max_quantity: number;
}): number =>
  Math.max(
    0,
    Math.min(
      listing.max_quantity,
      listing.max_attendees - listing.attendee_count,
    ),
  );

const activeListing = async (slug: string) => {
  const candidate = await getListingWithCountBySlug(slug);
  return candidate?.active ? candidate : null;
};

const bookingEvidence = (
  bookingId: number,
  request: BookingRequest,
  ticketId: string,
): BookingEvidence => ({
  booking: {
    id: String(bookingId),
    listingSlug: request.listingSlug,
    quantity: request.quantity,
    ticketId,
    ticketUrl: `/t/${ticketId}`,
  },
});

const createBooking = async (
  key: string,
  request: BookingRequest,
  fingerprint: string,
): Promise<Response> => {
  const listing = await activeListing(request.listingSlug);
  if (listing === null) {
    return apiErrorResponse("listing_not_found", 404);
  }
  if (request.quantity > availableQuantity(listing)) {
    return await recordRejectedBooking(key, fingerprint, request);
  }

  const ticketId = generateTicketToken();
  let outcome!: BookingEvidence;
  return await reconcileFailure(key, fingerprint, async () => {
    await settings.loadKeys([CONFIG_KEYS.PUBLIC_KEY]);
    const result = await createAttendeeAtomicImpl(
      {
        bookings: [
          {
            date: null,
            durationDays: listing.duration_days,
            listingId: listing.id,
            quantity: request.quantity,
          },
        ],
        email: request.attendee.email,
        name: request.attendee.name,
        source: "public",
        ticketToken: ticketId,
      },
      async (tx, bookingId) => {
        outcome = bookingEvidence(bookingId, request, ticketId);
        await tx.execute(
          operationInsert(
            key,
            fingerprint,
            request,
            outcome,
            201,
            bookingId,
            ticketId,
          ),
        );
      },
    );
    if (!result.success) {
      return await recordRejectedBooking(key, fingerprint, request);
    }
    return await committedResponse(key, fingerprint);
  });
};

const parseBookingRequest = async (
  request: Request,
): Promise<BookingRequest | null> => {
  try {
    return v.parse(BookingRequestSchema, await request.json());
  } catch {
    return null;
  }
};

const handleBookingCreate = async (request: Request): Promise<Response> => {
  const key = request.headers.get("idempotency-key");
  if (
    key === null ||
    key.length === 0 ||
    key.length > IDEMPOTENCY_KEY_MAX_LENGTH
  ) {
    return apiErrorResponse("invalid_idempotency_key", 400);
  }
  const body = await parseBookingRequest(request);
  if (body === null) return apiErrorResponse("invalid_request", 400);
  const fingerprint = await fingerprintRequest(body);
  const operation = await operationByKey(key);
  return operation === null
    ? await createBooking(key, body, fingerprint)
    : replayResponse(operation, fingerprint);
};

const listingResponse = async (slug: string): Promise<Response> => {
  const listing = await activeListing(slug);
  if (listing === null) {
    return apiErrorResponse("listing_not_found", 404);
  }
  return jsonResponse({
    listing: {
      availableQuantity: availableQuantity(listing),
      bookedQuantity: listing.attendee_count,
      capacity: listing.max_attendees,
      name: listing.name,
      slug: listing.slug,
    },
  });
};

const bookingResponse = async (id: number): Promise<Response> => {
  const operation = await queryOne<StoredOperation>(
    `SELECT booking_id, idempotency_key, listing_slug, outcome_json, quantity,
            request_fingerprint, status_code, ticket_id
       FROM integration_operations
      WHERE booking_id = ?`,
    [id],
  );
  return operation === null
    ? apiErrorResponse("booking_not_found", 404)
    : jsonResponse(JSON.parse(operation.outcome_json));
};

const ticketResponse = async (ticketId: string): Promise<Response> => {
  const operation = await queryOne<StoredOperation>(
    `SELECT booking_id, idempotency_key, listing_slug, outcome_json, quantity,
            request_fingerprint, status_code, ticket_id
       FROM integration_operations
      WHERE ticket_id = ?`,
    [ticketId],
  );
  if (operation === null) {
    return apiErrorResponse("ticket_not_found", 404);
  }
  return jsonResponse({
    ticket: {
      bookingId: String(operation.booking_id),
      id: operation.ticket_id,
      listingSlug: operation.listing_slug,
      quantity: operation.quantity,
      renderUrl: `/t/${operation.ticket_id}`,
    },
  });
};

/** Handle a recognized booking-kernel route, or return null for an unknown path. */
export async function handleIntegrationBookingRequest(
  request: Request,
  path: string,
  method: string,
): Promise<Response | null> {
  if (method === "POST" && path === "/integration/v1/bookings") {
    return await handleBookingCreate(request);
  }
  const listing = path.match(/^\/integration\/v1\/listings\/([^/]+)$/);
  if (method === "GET" && listing) {
    return await listingResponse(decodeURIComponent(listing[1]!));
  }
  const booking = path.match(/^\/integration\/v1\/bookings\/(\d+)$/);
  if (method === "GET" && booking) {
    return await bookingResponse(Number(booking[1]!));
  }
  const ticket = path.match(/^\/integration\/v1\/tickets\/([^/]+)$/);
  if (method === "GET" && ticket) {
    return await ticketResponse(decodeURIComponent(ticket[1]!));
  }
  return null;
}
