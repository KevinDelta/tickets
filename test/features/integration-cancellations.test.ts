import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleIntegrationCancellationRequest } from "#routes/integration-cancellations.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import "./integration-bookings.test.ts";

test("leaves non-cancellation integration routes unhandled", async () => {
  const response = await handleIntegrationCancellationRequest(
    mockRequest("/integration/v1/bookings"),
    "/integration/v1/bookings",
    "GET",
  );
  expect(response).toBeNull();
});
