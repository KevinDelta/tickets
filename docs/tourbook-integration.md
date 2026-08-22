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
- Container manifest digest:
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

## Build and verify

The bake definition builds both supported Linux platforms from the pinned Deno
manifest:

```sh
docker buildx bake integration
```

Run the behavior test with the repository harness:

```sh
deno task test:files test/features/integration.test.ts
```

Run all required repository checks before a pull request:

```sh
deno task precommit
```
