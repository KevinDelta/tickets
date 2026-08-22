/** Durable idempotency primitives shared by Tourbook kernel mutations. */

/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { jsonResponse } from "#routes/response.ts";
import { toBase64Url } from "#shared/crypto/utils.ts";
import {
  insert,
  queryOne,
  resultRows,
  type SqlStatement,
  type TxScope,
} from "#shared/db/client.ts";
import { nowIso } from "#shared/now.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

/* jscpd:ignore-end */

export const BOOKING_SCOPE = "integration:booking:create";
export const CANCELLATION_SCOPE = "integration:booking:cancel";
export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;
export const PositiveQuantitySchema = integerAtLeast(1);

export const idempotencyKeyFrom = (request: Request): string | null => {
  const key = request.headers.get("idempotency-key");
  return key !== null &&
    key.length > 0 &&
    key.length <= IDEMPOTENCY_KEY_MAX_LENGTH
    ? key
    : null;
};

const parseMutationRequest = async <TSchema extends v.GenericSchema>(
  request: Request,
  schema: TSchema,
): Promise<{ body: v.InferOutput<TSchema>; key: string } | Response> => {
  const key = idempotencyKeyFrom(request);
  if (key === null) return apiErrorResponse("invalid_idempotency_key", 400);
  try {
    return { body: v.parse(schema, await request.json()), key };
  } catch {
    return apiErrorResponse("invalid_request", 400);
  }
};

export const handleMutationRequest = async <TSchema extends v.GenericSchema>(
  request: Request,
  schema: TSchema,
  fingerprintOf: (body: v.InferOutput<TSchema>) => Promise<string>,
  run: (
    body: v.InferOutput<TSchema>,
    key: string,
    fingerprint: string,
  ) => Promise<Response>,
): Promise<Response> => {
  const parsed = await parseMutationRequest(request, schema);
  if (parsed instanceof Response) return parsed;
  const fingerprint = await fingerprintOf(parsed.body);
  return await run(parsed.body, parsed.key, fingerprint);
};

export type StoredOperation = {
  booking_id: number | null;
  idempotency_key: string;
  listing_slug: string;
  outcome_json: string;
  quantity: number;
  request_fingerprint: string;
  status_code: number;
  ticket_id: string | null;
};

const OPERATION_COLUMNS = `booking_id, idempotency_key, listing_slug, outcome_json, quantity,
   request_fingerprint, status_code, ticket_id`;

export const operationByKey = (
  scope: string,
  key: string,
): Promise<StoredOperation | null> =>
  queryOne<StoredOperation>(
    `SELECT ${OPERATION_COLUMNS}
       FROM integration_operations
      WHERE scope = ? AND idempotency_key = ?`,
    [scope, key],
  );

export const operationByKeyInTransaction = async (
  tx: TxScope,
  scope: string,
  key: string,
): Promise<StoredOperation | null> => {
  const result = await tx.execute({
    args: [scope, key],
    sql: `SELECT ${OPERATION_COLUMNS}
            FROM integration_operations
           WHERE scope = ? AND idempotency_key = ?`,
  });
  return resultRows<StoredOperation>(result)[0] ?? null;
};

export const fingerprintMaterial = async (
  material: unknown[],
): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify(material));
  return toBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  );
};

export const storedResponse = (operation: StoredOperation): Response =>
  jsonResponse(JSON.parse(operation.outcome_json), operation.status_code);

export const replayResponse = (
  operation: StoredOperation,
  fingerprint: string,
): Response =>
  operation.request_fingerprint === fingerprint
    ? storedResponse(operation)
    : apiErrorResponse("idempotency_conflict", 409);

const operationResponseOrThrow = async (
  scope: string,
  error: unknown,
  key: string,
  fingerprint: string,
): Promise<Response> => {
  const operation = await operationByKey(scope, key);
  if (operation !== null) return replayResponse(operation, fingerprint);
  throw error;
};

export const reconcileOperationFailure = async (
  scope: string,
  key: string,
  fingerprint: string,
  run: () => Promise<Response>,
): Promise<Response> => {
  try {
    return await run();
  } catch (error) {
    return await operationResponseOrThrow(scope, error, key, fingerprint);
  }
};

export const committedOperationResponse = (
  scope: string,
  key: string,
  fingerprint: string,
): Promise<Response> =>
  operationResponseOrThrow(scope, new Error(), key, fingerprint);

export const operationInsert = (
  scope: string,
  key: string,
  fingerprint: string,
  request: { listingSlug: string; quantity: number },
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
    scope,
    status_code: statusCode,
    ticket_id: ticketId,
  });
