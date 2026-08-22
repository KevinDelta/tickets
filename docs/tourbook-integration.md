# Tourbook integration image

This fork provides the isolated Chobble service used by Tourbook integration
tests. The application repository does not copy Chobble source code into its own
tree.

## Source provenance

- Upstream repository: `https://github.com/chobbledotcom/tickets`
- Fork repository: `https://github.com/KevinDelta/tickets`
- Upstream release: `v2026-08-18-095849`
- Upstream commit: `9573132df08172981609ebee55e3f23c804fbe6e`
- Container base: `denoland/deno:alpine-2.5.6`
- Container-base manifest digest:
  `sha256:b9c7668c78fe393893f00b0fc8ba3d0f2e1bbb8f891a79a963b3b713ab110767`

The upstream project is licensed under the GNU Affero General Public License.
Any network deployment must offer its users the complete corresponding source
for the exact deployed version, including this fork's changes. The public fork
is the corresponding-source location for this image. Keep the published image
digest linked to the exact fork commit that built it.

## Integration routes

Set `TOURBOOK_INTEGRATION_KEY` to a revocable random value of at least 32
characters. Integration routes return `404` when this variable is absent. They
return `401` for a missing bearer credential and `403` for an invalid bearer
credential. Rotate the value and restart the container to revoke access.

Set `TOURBOOK_INTEGRATION_FIXTURE=true` only on the isolated test service. The
reset route returns `404` in every other environment. A reset erases the service
database and creates one active, date-less listing named
`Tourbook integration fixture` with slug `tourbook-integration` and capacity
`12`. It leaves no bookings or attendee records. Repeated or concurrent reset
requests converge to the same state.

Check database readiness:

```sh
curl --fail-with-body \
  --header "Authorization: Bearer ${TOURBOOK_INTEGRATION_KEY}" \
  http://localhost:3000/integration/v1/health
```

Reset the fixture:

```sh
curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer ${TOURBOOK_INTEGRATION_KEY}" \
  http://localhost:3000/integration/v1/fixture/reset
```

The responses contain fixture metadata only. They do not contain attendee
personal data.

Read the fixture listing and its current product-level availability:

```sh
curl --fail-with-body \
  --header "Authorization: Bearer ${TOURBOOK_INTEGRATION_KEY}" \
  http://localhost:3000/integration/v1/listings/tourbook-integration
```

Create one exact-quantity booking with a caller-scoped Idempotency Key:

```sh
curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer ${TOURBOOK_INTEGRATION_KEY}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: tourbook-booking-123" \
  --data '{"attendee":{"email":"traveller@example.com","name":"Traveller"},"listingSlug":"tourbook-integration","quantity":2}' \
  http://localhost:3000/integration/v1/bookings
```

The mutation stores its scope, Idempotency Key, SHA-256 material-request
fingerprint, and original outcome in the same transaction as a successful
booking. An identical replay returns that outcome without consuming capacity;
different material input with the same key returns `409`. Insufficient capacity
also returns `409` and is never silently reduced to the remaining capacity.

The returned booking `id` and `ticketId` can be retrieved from
`GET /integration/v1/bookings/:id` and `GET /integration/v1/tickets/:ticketId`.
These responses contain stable booking and ticket evidence but no attendee PII.
Chobble retains the encrypted attendee details and owns ticket rendering at the
returned `/t/:ticketId` URL.

Cancel an exact remaining quantity from a booking:

```sh
curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer ${TOURBOOK_INTEGRATION_KEY}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: tourbook-cancellation-123" \
  --data '{"quantity":1}' \
  http://localhost:3000/integration/v1/bookings/123/cancellations
```

The response reports the exact `affectedQuantity`, cumulative
`cancelledQuantity`, and `remainingQuantity`. Sequential cancellations can
reduce a booking to zero but cannot make it negative. An over-cancellation is
stored as a durable `409` outcome. Identical retries return the original result;
reusing the key for a different booking or quantity returns an idempotency
conflict.

Read current cancellation state with
`GET /integration/v1/bookings/:id/cancellations`. Booking and ticket reads also
report issued, cancelled, and remaining quantities. A fully cancelled ticket has
`valid: false`; a partially cancelled ticket remains valid for exactly its
remaining quantity. These routes revoke Chobble ticket validity only. The
integration boundary intentionally exposes no refund endpoint, refund status, or
payment-refund authority.

## Build and verify

The bake definition builds both supported Linux platforms from the pinned Deno
manifest:

```sh
docker buildx bake integration
```

Every push to the pinned `tourbook-v2026-08-18-095849` branch publishes one
immutable, commit-tagged multi-architecture image to
`ghcr.io/kevindelta/tickets`. The workflow records the source commit, OCI
manifest digest, and digest-qualified image reference in its job summary. Pull
and deploy by digest, never by the convenience commit tag. Feature branches and
pull requests build both architectures without publishing them.

Run the behavior test with the repository harness:

```sh
deno task test:files test/features/integration.test.ts \
  test/features/integration-bookings.test.ts
```

Run all required repository checks before a pull request:

```sh
deno task precommit
```
