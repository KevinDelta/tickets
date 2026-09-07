/** Exact-quantity ticket revocation for the authenticated Tourbook kernel. */

/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { apiErrorResponse } from "#routes/api/cors.ts";
import {
  BOOKING_SCOPE,
  CANCELLATION_SCOPE,
  committedOperationResponse,
  fingerprintMaterial,
  handleMutationRequest,
  operationByKeyInTransaction,
  operationInsert,
  PositiveQuantitySchema,
  reconcileOperationFailure,
  type StoredOperation,
} from "#routes/integration-operations.ts";
import { jsonResponse } from "#routes/response.ts";
import {
  queryOne,
  resultRows,
  type TxScope,
  withTransaction,
} from "#shared/db/client.ts";

/* jscpd:ignore-end */

const CancellationRequestSchema = v.object({
  quantity: PositiveQuantitySchema,
});

type CancellationRequest = v.InferOutput<typeof CancellationRequestSchema>;
type CancellationCommand = {
  fingerprint: string;
  id: number;
  key: string;
  request: CancellationRequest;
};
type KernelBookingRow = StoredOperation & {
  booking_row_id: number;
  remaining_quantity: number;
};
type CancellationState = {
  bookingId: string;
  cancelledQuantity: number;
  issuedQuantity: number;
  remainingQuantity: number;
  status: "active" | "cancelled" | "partially_cancelled";
};

const BOOKING_STATE_COLUMNS = `operation.booking_id, operation.idempotency_key, operation.listing_slug,
   operation.outcome_json, operation.quantity, operation.request_fingerprint,
   operation.status_code, operation.ticket_id,
   booking.id AS booking_row_id, booking.quantity AS remaining_quantity`;

const bookingStateSql = (lookup: "booking" | "ticket"): string =>
  `SELECT ${BOOKING_STATE_COLUMNS}
     FROM integration_operations AS operation
     JOIN listing_attendees AS booking
       ON booking.attendee_id = operation.booking_id
    WHERE operation.scope = ? AND operation.${
      lookup === "booking" ? "booking_id" : "ticket_id"
    } = ?`;

const bookingStateById = (id: number): Promise<KernelBookingRow | null> =>
  queryOne<KernelBookingRow>(bookingStateSql("booking"), [BOOKING_SCOPE, id]);

const bookingStateByTicket = (
  ticketId: string,
): Promise<KernelBookingRow | null> =>
  queryOne<KernelBookingRow>(bookingStateSql("ticket"), [
    BOOKING_SCOPE,
    ticketId,
  ]);

const bookingStateInTransaction = async (
  tx: TxScope,
  id: number,
): Promise<KernelBookingRow | null> => {
  const result = await tx.execute({
    args: [BOOKING_SCOPE, id],
    sql: bookingStateSql("booking"),
  });
  return resultRows<KernelBookingRow>(result)[0] ?? null;
};

const cancellationState = (row: KernelBookingRow): CancellationState => {
  const cancelledQuantity = row.quantity - row.remaining_quantity;
  return {
    bookingId: String(row.booking_id),
    cancelledQuantity,
    issuedQuantity: row.quantity,
    remainingQuantity: row.remaining_quantity,
    status:
      row.remaining_quantity === 0
        ? "cancelled"
        : cancelledQuantity === 0
          ? "active"
          : "partially_cancelled",
  };
};

const responseWithBookingState = async (
  id: number,
  render: (row: KernelBookingRow) => Response,
): Promise<Response> => {
  const row = await bookingStateById(id);
  return row === null
    ? apiErrorResponse("booking_not_found", 404)
    : render(row);
};

/** Read current booking evidence, including cancellation state. */
export const bookingStateResponse = (id: number): Promise<Response> =>
  responseWithBookingState(id, (row) => {
    const state = cancellationState(row);
    return jsonResponse({
      booking: {
        cancelledQuantity: state.cancelledQuantity,
        id: state.bookingId,
        issuedQuantity: state.issuedQuantity,
        listingSlug: row.listing_slug,
        quantity: state.issuedQuantity,
        remainingQuantity: state.remainingQuantity,
        status: state.status,
        ticketId: row.ticket_id,
        ticketUrl: `/t/${row.ticket_id}`,
      },
    });
  });

/** Read current ticket validity without exposing attendee PII. */
export const ticketStateResponse = async (
  ticketId: string,
): Promise<Response> => {
  const row = await bookingStateByTicket(ticketId);
  if (row === null) return apiErrorResponse("ticket_not_found", 404);
  const state = cancellationState(row);
  return jsonResponse({
    ticket: {
      bookingId: state.bookingId,
      cancelledQuantity: state.cancelledQuantity,
      id: row.ticket_id,
      issuedQuantity: state.issuedQuantity,
      listingSlug: row.listing_slug,
      quantity: state.remainingQuantity,
      renderUrl: `/t/${row.ticket_id}`,
      status: state.status,
      valid: state.remainingQuantity > 0,
    },
  });
};

const cancellationOutcome = (
  row: KernelBookingRow,
  affectedQuantity: number,
  remainingQuantity: number,
) => ({
  cancellation: {
    ...cancellationState({ ...row, remaining_quantity: remainingQuantity }),
    affectedQuantity,
  },
});

const persistCancellation = async (
  tx: TxScope,
  row: KernelBookingRow,
  request: CancellationRequest,
  key: string,
  fingerprint: string,
): Promise<void> => {
  const overCancellation = request.quantity > row.remaining_quantity;
  const remainingQuantity = overCancellation
    ? row.remaining_quantity
    : row.remaining_quantity - request.quantity;
  const outcome = {
    ...cancellationOutcome(
      row,
      overCancellation ? 0 : request.quantity,
      remainingQuantity,
    ),
    ...(overCancellation
      ? { error: "cancellation_exceeds_remaining_quantity" }
      : {}),
  };
  const statusCode = overCancellation ? 409 : 200;
  if (!overCancellation) {
    const updated = await tx.execute({
      args: [remainingQuantity, row.booking_row_id, row.remaining_quantity],
      sql: `UPDATE listing_attendees
               SET quantity = ?
             WHERE id = ? AND quantity = ?`,
    });
    if (updated.rowsAffected !== 1) throw new Error();
  }
  await tx.execute(
    operationInsert(
      CANCELLATION_SCOPE,
      key,
      fingerprint,
      { listingSlug: row.listing_slug, quantity: request.quantity },
      outcome,
      statusCode,
      null,
      null,
    ),
  );
};

const cancellationTransaction = async (
  tx: TxScope,
  command: CancellationCommand,
): Promise<boolean> => {
  const { fingerprint, id, key, request } = command;
  if (
    (await operationByKeyInTransaction(tx, CANCELLATION_SCOPE, key)) !== null
  ) {
    return true;
  }
  const row = await bookingStateInTransaction(tx, id);
  if (row === null) return false;
  await persistCancellation(tx, row, request, key, fingerprint);
  return true;
};

const commitCancellation = async (
  command: CancellationCommand,
): Promise<Response> => {
  const { fingerprint, key } = command;
  const bookingFound = await withTransaction((tx) =>
    cancellationTransaction(tx, command),
  );
  return bookingFound
    ? await committedOperationResponse(CANCELLATION_SCOPE, key, fingerprint)
    : apiErrorResponse("booking_not_found", 404);
};

const cancellationCreateResponse = async (
  request: Request,
  id: number,
): Promise<Response> =>
  await handleMutationRequest(
    request,
    CancellationRequestSchema,
    (body) => fingerprintMaterial([id, body.quantity]),
    (body, key, fingerprint) =>
      reconcileOperationFailure(CANCELLATION_SCOPE, key, fingerprint, () =>
        commitCancellation({ fingerprint, id, key, request: body }),
      ),
  );

/** Handle a recognized cancellation-kernel route, or null for another path. */
export const handleIntegrationCancellationRequest = async (
  ...args: [request: Request, path: string, method: string]
): Promise<Response | null> => {
  const [request, path, method] = args;
  const match = path.match(
    /^\/integration\/v1\/bookings\/(\d+)\/cancellations$/,
  );
  if (!match) return null;
  const id = Number(match[1]!);
  if (method === "POST") return await cancellationCreateResponse(request, id);
  return method === "GET"
    ? await responseWithBookingState(id, (row) =>
        jsonResponse({ cancellation: cancellationState(row) }),
      )
    : null;
};
