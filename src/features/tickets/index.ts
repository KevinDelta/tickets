/**
 * Public ticket view routes - /t/:tokens and /t/:token/svg
 * Displays ticket information for attendees using their ticket tokens.
 * The SVG endpoint serves individual QR codes for CDN caching.
 */

import {
  htmlResponse,
  notFoundResponse,
  temporaryErrorResponse,
} from "#routes/response.ts";
import {
  createTokenRoute,
  lookupAttendees,
  resolveEntries,
  type TokenEntry,
  type TokenRouteFn,
  withTokenRateLimit,
} from "#routes/tickets/token-utils.ts";
import { signAttachmentUrl } from "#shared/attachment-url.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { packageDisplaysForRows } from "#shared/db/groups.ts";
import { settings } from "#shared/db/settings.ts";
import { generateQrSvg } from "#shared/qr.ts";
import { buildCheckinUrl } from "#shared/ticket-url.ts";
import { type TicketCard, ticketViewPage } from "#templates/tickets.tsx";
import { renderTicketPdf, ticketPdfEnabled, ticketPdfHtml } from "./pdf.ts";

/** Build a ticket card for one entry, keyed by that entry's OWN token. Keying on
 * the row's real token (not the URL's first token) keeps a multi-token page's
 * distinct attendees on distinct cards/QRs and lets package collapsing bucket by
 * (token, package) without merging two attendees. This view doesn't decrypt, so
 * the token is re-derived from the URL by index rather than read off the
 * attendee (whose `ticket_token` is only populated after decryption). */
const buildTicketCard = async (
  entry: TokenEntry,
  token: string,
): Promise<TicketCard> => {
  const attachmentUrl = entry.listing.attachment_url
    ? await signAttachmentUrl(entry.listing.id, entry.attendee.id)
    : undefined;
  return {
    ...(attachmentUrl !== undefined ? { attachmentUrl } : {}),
    entry,
    token,
  };
};

const hashTicketToken = async (
  token: string,
): Promise<readonly [string, string]> => [await hmacHash(token), token];

const cardFor = (
  entry: TokenEntry,
  tokenByIndex: Map<string, string>,
): Promise<TicketCard> =>
  buildTicketCard(entry, tokenByIndex.get(entry.attendee.ticket_token_index)!);

/** Attach each resolved entry to the URL token that identifies its attendee. */
const buildTicketCards = async (
  entries: TokenEntry[],
  tokens: string[],
): Promise<TicketCard[]> => {
  const tokenByIndex = new Map(await Promise.all(tokens.map(hashTicketToken)));
  return Promise.all(entries.map((entry) => cardFor(entry, tokenByIndex)));
};

/** Curry a ticket handler over the shared preamble: look the tokens up, drop
 * no-quantity ghost lines, and 404 when nothing real is left, then hand the real
 * entries and tokens to `render`. */
const withResolvedEntries =
  (render: (entries: TokenEntry[], tokens: string[]) => Promise<Response>) =>
  async (_request: Request, tokens: string[]): Promise<Response> => {
    const result = await lookupAttendees(tokens);
    if (!result.ok) return result.response;
    const entries = await resolveEntries(result.attendees);
    if (entries.length === 0) return notFoundResponse();
    return render(entries, tokens);
  };

type ResolvedTicket = {
  cards: TicketCard[];
  packageDisplays: Awaited<ReturnType<typeof packageDisplaysForRows>>;
  tokens: string[];
};

type TicketSource = { entries: TokenEntry[]; tokens: string[] };

const resolveTicket = async (
  source: TicketSource,
): Promise<ResolvedTicket> => ({
  cards: await buildTicketCards(source.entries, source.tokens),
  packageDisplays: await packageDisplaysForRows(source.entries),
  tokens: source.tokens,
});

const renderResolvedTicket = async (
  entries: TokenEntry[],
  tokens: string[],
  render: (ticket: ResolvedTicket) => Promise<Response>,
): Promise<Response> => render(await resolveTicket({ entries, tokens }));

const withResolvedTicket = (
  render: (ticket: ResolvedTicket) => Promise<Response>,
) => {
  const renderEntries = (entries: TokenEntry[], tokens: string[]) =>
    renderResolvedTicket(entries, tokens, render);
  return withResolvedEntries(renderEntries);
};

/** Handle GET /t/:tokens. One token can map to several cards (multi-listing);
 * they share the first URL token (same attendee). */
const viewResponse = async (ticket: ResolvedTicket): Promise<Response> => {
  const { cards, packageDisplays, tokens } = ticket;
  // This view doesn't decrypt, so each resolved attendee carries only its token
  // INDEX. Map every URL token to its index, then re-attach the matching token to
  // each card so cards key by their real token.
  // Collapse each package's rows into one card (members grouped, or hidden),
  // keyed by (token, package). Each card carries its own attendee token, so a
  // multi-token URL (`/t/a+b`) keeps distinct attendees' cards — and check-in
  // QRs — separate while still collapsing each package. Disabling collapsing for
  // multi-token pages would render a hidden package's member rows as normal cards
  // and leak the concealed names, so it is always enabled.
  return htmlResponse(
    ticketViewPage(
      cards,
      settings.appleWallet.hasConfig,
      settings.googleWallet.hasConfig,
      packageDisplays,
      ticketPdfEnabled() ? `/t/${tokens.join("+")}/pdf` : undefined,
    ),
  );
};

const handleTicketView = withResolvedTicket(viewResponse);

const pdfResponse = async (ticket: ResolvedTicket): Promise<Response> => {
  try {
    const pdf = await renderTicketPdf(
      await ticketPdfHtml(ticket.cards, ticket.packageDisplays),
    );
    return new Response(pdf.buffer as ArrayBuffer, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": 'attachment; filename="ticket.pdf"',
        "content-type": "application/pdf",
      },
    });
  } catch {
    return temporaryErrorResponse();
  }
};

/** Handle GET /t/:tokens/pdf. PDFs render the current ticket and are never stored. */
const handleTicketPdf = withResolvedTicket(pdfResponse);

/** One year in seconds — SVG tickets never change so cache aggressively */
const ONE_YEAR = 365 * 24 * 60 * 60;

/** Handle GET /t/:token/svg — serve QR code SVG for CDN caching */
const handleTicketSvg = withResolvedEntries(async (_entries, tokens) => {
  const svg = await generateQrSvg(buildCheckinUrl(tokens[0]!));
  return new Response(svg, {
    headers: {
      "cache-control": `public, max-age=${ONE_YEAR}, immutable`,
      "content-type": "image/svg+xml",
    },
  });
});

/** Token-based route for the regular ticket view */
const tokenRoute = createTokenRoute("t", { GET: handleTicketView });

/** Route ticket view and SVG requests */
export const routeTicketView: TokenRouteFn = (
  request,
  path,
  method,
  server,
) => {
  const rateLimitTicketRoute = (
    tokens: string[],
    handler: (request: Request, tokens: string[]) => Promise<Response>,
  ): Promise<Response> =>
    withTokenRateLimit(request, server, tokens, () => handler(request, tokens));
  if (method === "GET") {
    const assetMatch = path.match(/^\/t\/([^/]+)\/(pdf|svg)$/);
    if (assetMatch?.[2] === "pdf") {
      const pdfTokens = assetMatch[1]!;
      if (!ticketPdfEnabled()) return Promise.resolve(notFoundResponse());
      return rateLimitTicketRoute(pdfTokens.split("+"), handleTicketPdf);
    }
    if (assetMatch?.[2] === "svg" && !assetMatch[1]!.includes("+")) {
      const svgToken = assetMatch[1]!;
      return rateLimitTicketRoute([svgToken], handleTicketSvg);
    }
  }
  return tokenRoute(request, path, method, server);
};
