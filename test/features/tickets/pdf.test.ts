import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ticketPdfHtml } from "#routes/tickets/pdf.ts";
import { registerPublicTemplateHooks } from "#test/ui/templates/helpers.ts";
import { testTokenEntry } from "#test-utils/factories.ts";

describe("ticket PDF document", () => {
  registerPublicTemplateHooks();

  test("keeps a hidden package's member names out of the PDF", async () => {
    const html = await ticketPdfHtml(
      [
        {
          entry: testTokenEntry({
            attendee: { package_group_id: 4, quantity: 1 },
            listing: { name: "Secret boat" },
          }),
          token: "ticket-token",
        },
      ],
      new Map([[4, { hideListings: true, name: "Harbour pass" }]]),
    );

    expect(html).toContain("Harbour pass");
    expect(html).not.toContain("Secret boat");
    expect(html).toContain("<svg");
  });

  test("does not add a QR code to a purchase-only PDF", async () => {
    const html = await ticketPdfHtml(
      [
        {
          entry: testTokenEntry({ listing: { purchase_only: true } }),
          token: "purchase-token",
        },
      ],
      new Map(),
    );

    expect(html).not.toContain("<svg");
    expect(html).not.toContain("purchase-token");
  });
});
