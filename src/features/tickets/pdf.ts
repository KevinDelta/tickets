import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import {
  bookedRangeLabel,
  formatDatetimeLabel,
  widestDatedEntry,
} from "#shared/dates.ts";
import type { PackageDisplay } from "#shared/db/groups.ts";
import { getEnv } from "#shared/env.ts";
import { escapeHtml } from "#shared/jsx/escape-html.ts";
import {
  namesConcealed,
  packagePrivacyOfDisplay,
} from "#shared/package-privacy.ts";
import { generateQrSvg } from "#shared/qr.ts";
import { buildCheckinUrl } from "#shared/ticket-url.ts";
import { clampDurationDays } from "#shared/types.ts";
import type { TicketCard } from "#templates/tickets.tsx";

const encoder = new TextEncoder();

/** Whether this Docker deployment can create ticket PDFs. */
export const ticketPdfEnabled = (): boolean =>
  getEnv("TICKET_PDF_ENABLED") === "true";

const bookingDate = (card: TicketCard): string =>
  bookedRangeLabel(
    card.entry.attendee.date,
    card.entry.attendee.end_date,
    clampDurationDays(card.entry.listing.duration_days),
  );

const optionalLine = (label: string, value: string | null): string =>
  value ? `<p><strong>${label}</strong> ${escapeHtml(value)}</p>` : "";

const qr = (
  token: string,
  purchaseOnly: boolean,
  svgByToken: ReadonlyMap<string, string>,
): string => {
  if (purchaseOnly) return "";
  return `<div class="qr">${svgByToken.get(token)!}</div><p class="token">${escapeHtml(token)}</p>`;
};

const packageKey = (card: TicketCard): string =>
  `${card.token}\u0000${card.entry.attendee.package_group_id}`;

const packageDisplayFor = (
  card: TicketCard,
  packageDisplays: ReadonlyMap<number, PackageDisplay>,
): PackageDisplay | undefined =>
  packageDisplays.get(card.entry.attendee.package_group_id);

const singleTicket = (
  card: TicketCard,
  svgByToken: ReadonlyMap<string, string>,
): string => {
  const { attendee, listing } = card.entry;
  const price = Number(attendee.price_paid);
  return `<article class="ticket">
    <p class="eyebrow">${t("tickets.title")}</p>
    <h1>${escapeHtml(listing.name)}</h1>
    ${optionalLine(t("public.ticket.date_label"), listing.date ? formatDatetimeLabel(listing.date) : null)}
    ${optionalLine(t("public.ticket.location_label"), listing.location || null)}
    ${optionalLine(t("tickets.booking_date"), bookingDate(card))}
    <p><strong>${t("tickets.quantity")}</strong> ${attendee.quantity}</p>
    ${price ? `<p><strong>${t("tickets.price")}</strong> ${escapeHtml(formatCurrency(price))}</p>` : ""}
    ${listing.non_transferable && !listing.purchase_only ? `<p class="notice">${t("tickets.non_transferable")}</p>` : ""}
    ${qr(card.token, listing.purchase_only, svgByToken)}
  </article>`;
};

const packageTicket = (
  cards: TicketCard[],
  display: PackageDisplay,
  svgByToken: ReadonlyMap<string, string>,
): string => {
  const purchaseOnly = cards.every((card) => card.entry.listing.purchase_only);
  const memberLines = namesConcealed(packagePrivacyOfDisplay(display))
    ? ""
    : `<ul>${cards.map((card) => `<li>${escapeHtml(card.entry.listing.name)} ×${card.entry.attendee.quantity}</li>`).join("")}</ul>`;
  const totalQuantity = cards.reduce(
    (total, card) => total + card.entry.attendee.quantity,
    0,
  );
  const dated = widestDatedEntry(cards.map((card) => card.entry));
  return `<article class="ticket">
    <p class="eyebrow">${t("tickets.title")}</p>
    <h1>${escapeHtml(display.name)}</h1>
    ${dated ? optionalLine(t("tickets.booking_date"), bookingDate({ ...cards[0]!, entry: dated })) : ""}
    <p><strong>${t("tickets.quantity")}</strong> ${totalQuantity}</p>
    ${memberLines}
    ${cards.some((card) => card.entry.listing.non_transferable && !card.entry.listing.purchase_only) ? `<p class="notice">${t("tickets.non_transferable")}</p>` : ""}
    ${qr(cards[0]!.token, purchaseOnly, svgByToken)}
  </article>`;
};

const ticketCards = (
  cards: TicketCard[],
  packageDisplays: ReadonlyMap<number, PackageDisplay>,
  svgByToken: ReadonlyMap<string, string>,
): string[] => {
  const packages = new Map<string, TicketCard[]>();
  for (const card of cards) {
    const display = packageDisplayFor(card, packageDisplays);
    if (!display) continue;
    const key = packageKey(card);
    const grouped = packages.get(key);
    if (grouped) grouped.push(card);
    else packages.set(key, [card]);
  }
  const rendered = new Set<string>();
  return cards.flatMap((card) => {
    const display = packageDisplayFor(card, packageDisplays);
    if (!display) return [singleTicket(card, svgByToken)];
    const key = packageKey(card);
    if (rendered.has(key)) return [];
    rendered.add(key);
    return [packageTicket(packages.get(key)!, display, svgByToken)];
  });
};

const pdfDocument = (cards: string[]): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <style>
      @page { size: 4in 6in; margin: 0.2in; }
      * { box-sizing: border-box; }
      body { color: #15213b; font-family: sans-serif; margin: 0; }
      .ticket { border: 2px solid #15213b; border-radius: 12px; min-height: 5.5in; padding: 0.25in; page-break-after: always; }
      .ticket:last-child { page-break-after: auto; }
      .eyebrow { color: #52627d; font-size: 9pt; font-weight: bold; letter-spacing: 0.08em; margin: 0 0 0.12in; text-transform: uppercase; }
      h1 { font-size: 20pt; line-height: 1.1; margin: 0 0 0.18in; }
      p, li { font-size: 10pt; line-height: 1.35; margin: 0.06in 0; }
      ul { margin: 0.08in 0; padding-left: 0.2in; }
      .notice { background: #fff5d6; border-radius: 4px; padding: 0.08in; }
      .qr { margin-top: 0.16in; text-align: center; }
      .qr svg { height: 1.55in; width: 1.55in; }
      .token { color: #52627d; font-family: monospace; font-size: 7pt; overflow-wrap: anywhere; text-align: center; }
    </style>
  </head>
  <body>${cards.join("")}</body>
</html>`;

/** Build a self-contained ticket document with one current check-in QR per card. */
export const ticketPdfHtml = async (
  cards: TicketCard[],
  packageDisplays: ReadonlyMap<number, PackageDisplay>,
): Promise<string> => {
  const tokens = [
    ...new Set(
      cards
        .filter((card) => !card.entry.listing.purchase_only)
        .map((card) => card.token),
    ),
  ];
  const svgByToken = new Map(
    await Promise.all(
      tokens.map(
        async (token) =>
          [token, await generateQrSvg(buildCheckinUrl(token))] as const,
      ),
    ),
  );
  return pdfDocument(ticketCards(cards, packageDisplays, svgByToken));
};

/** Render the self-contained document through the Docker image's WeasyPrint binary. */
export const renderTicketPdf = async (html: string): Promise<Uint8Array> => {
  const child = new Deno.Command("weasyprint", {
    args: ["-", "-"],
    stderr: "piped",
    stdin: "piped",
    stdout: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(encoder.encode(html));
  await writer.close();
  const result = await child.output();
  if (!result.success)
    throw new Error("WeasyPrint could not render the ticket PDF");
  return result.stdout;
};
