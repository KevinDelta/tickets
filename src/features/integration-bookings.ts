/** PII-minimized booking operations for the authenticated integration boundary. */

/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { apiErrorResponse } from "#routes/api/cors.ts";
import {
  bookingStateResponse,
  ticketStateResponse,
} from "#routes/integration-cancellations.ts";
import {
  BOOKING_SCOPE,
  committedOperationResponse,
  fingerprintMaterial,
  handleMutationRequest,
  operationByKey,
  operationInsert,
  PositiveQuantitySchema,
  reconcileOperationFailure,
  replayResponse,
} from "#routes/integration-operations.ts";
import { jsonResponse } from "#routes/response.ts";
import { generateTicketToken } from "#shared/crypto/utils.ts";
import { createAttendeeAtomicImpl } from "#shared/db/attendees/create.ts";
import { execute } from "#shared/db/client.ts";
import {
  getAllListings,
  getListingWithCountBySlug,
} from "#shared/db/listings/records.ts";
import { settings } from "#shared/db/settings.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";

/* jscpd:ignore-end */

const ShortTextSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(200));

const BookingRequestSchema = v.object({
  attendee: v.object({
    email: v.pipe(v.string(), v.email()),
    name: ShortTextSchema,
  }),
  listingSlug: ShortTextSchema,
  quantity: PositiveQuantitySchema,
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
const fingerprintRequest = (request: BookingRequest): Promise<string> =>
  fingerprintMaterial([
    request.listingSlug,
    request.quantity,
    request.attendee.name,
    request.attendee.email,
  ]);

const recordRejectedBooking = async (
  key: string,
  fingerprint: string,
  request: BookingRequest,
): Promise<Response> => {
  const outcome = { error: "insufficient_capacity" };
  return await reconcileOperationFailure(
    BOOKING_SCOPE,
    key,
    fingerprint,
    async () => {
      const statement = operationInsert(
        BOOKING_SCOPE,
        key,
        fingerprint,
        request,
        outcome,
        409,
        null,
        null,
      );
      await execute(statement.sql, statement.args);
      return await committedOperationResponse(BOOKING_SCOPE, key, fingerprint);
    },
  );
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

const listingEvidence = (listing: {
  attendee_count: number;
  max_attendees: number;
  max_quantity: number;
  name: string;
  kernel_location: {
    latitude: number;
    longitude: number;
    updatedAt: string;
  } | null;
  slug: string;
}) => ({
  availableQuantity: availableQuantity(listing),
  bookedQuantity: listing.attendee_count,
  capacity: listing.max_attendees,
  location:
    listing.kernel_location === null
      ? null
      : { ...listing.kernel_location, source: "ticketing_kernel" as const },
  name: listing.name,
  slug: listing.slug,
});

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
  return await reconcileOperationFailure(
    BOOKING_SCOPE,
    key,
    fingerprint,
    async () => {
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
              BOOKING_SCOPE,
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
      return await committedOperationResponse(BOOKING_SCOPE, key, fingerprint);
    },
  );
};

const handleBookingCreate = async (request: Request): Promise<Response> =>
  await handleMutationRequest(
    request,
    BookingRequestSchema,
    fingerprintRequest,
    async (body, key, fingerprint) => {
      const operation = await operationByKey(BOOKING_SCOPE, key);
      return operation === null
        ? await createBooking(key, body, fingerprint)
        : replayResponse(operation, fingerprint);
    },
  );

const listingResponse = async (slug: string): Promise<Response> => {
  const listing = await activeListing(slug);
  if (listing === null) {
    return apiErrorResponse("listing_not_found", 404);
  }
  return jsonResponse({ listing: listingEvidence(listing) });
};

const listingsResponse = async (): Promise<Response> => {
  const listings = (await getAllListings())
    .filter(({ active }) => active)
    .map(listingEvidence)
    .sort((left, right) => left.slug.localeCompare(right.slug));
  return jsonResponse({ listings });
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
  if (method === "GET" && path === "/integration/v1/listings") {
    return await listingsResponse();
  }
  const listing = path.match(/^\/integration\/v1\/listings\/([^/]+)$/);
  if (method === "GET" && listing) {
    return await listingResponse(decodeURIComponent(listing[1]!));
  }
  const booking = path.match(/^\/integration\/v1\/bookings\/(\d+)$/);
  if (method === "GET" && booking) {
    return await bookingStateResponse(Number(booking[1]!));
  }
  const ticket = path.match(/^\/integration\/v1\/tickets\/([^/]+)$/);
  if (method === "GET" && ticket) {
    return await ticketStateResponse(decodeURIComponent(ticket[1]!));
  }
  return null;
}
