import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";

describeWithEnv("ticket PDF route", { db: true }, () => {
  test("renders a current unified PDF ticket when Docker rendering is enabled", async () => {
    const { listing, token } = await createTestAttendeeWithToken(
      "Eve",
      "eve@test.com",
    );
    const written: Uint8Array[] = [];
    const commandNamespace = Deno as unknown as {
      Command: (...args: unknown[]) => unknown;
    };
    using _command = stub(commandNamespace, "Command", () => ({
      spawn: () => ({
        output: () =>
          Promise.resolve({
            code: 0,
            signal: null,
            stderr: new Uint8Array(),
            stdout: new TextEncoder().encode("%PDF-1.7"),
            success: true,
          }),
        stdin: {
          getWriter: () => ({
            close: () => Promise.resolve(),
            write: (value: Uint8Array) => {
              written.push(value);
              return Promise.resolve();
            },
          }),
        },
      }),
    }));
    using _enabled = stub(Deno.env, "get", (key: string) =>
      key === "TICKET_PDF_ENABLED" ? "true" : undefined,
    );

    const response = await awaitTestRequest(`/t/${token}/pdf`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("ticket.pdf");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("%PDF-1.7");
    const html = new TextDecoder().decode(written[0]);
    expect(html).toContain(listing.name);
    expect(html).toContain("<svg");
  });

  test("does not expose a PDF ticket when Docker rendering is disabled", async () => {
    const { token } = await createTestAttendeeWithToken("Eve", "eve@test.com");
    const response = await awaitTestRequest(`/t/${token}/pdf`);
    expect(response.status).toBe(404);
  });
});
