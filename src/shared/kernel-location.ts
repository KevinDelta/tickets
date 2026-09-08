/** Kernel-owned WGS84 location evidence published to authorized consumers. */

import * as v from "valibot";
import { isInstant } from "#shared/validation/timestamp.ts";

const boundedFinite = (min: number, max: number) =>
  v.pipe(v.number(), v.finite(), v.minValue(min), v.maxValue(max));

/** Coordinates an authenticated operator may set. Freshness is server-owned. */
export const KernelLocationInputSchema = v.object({
  latitude: boundedFinite(-90, 90),
  longitude: boundedFinite(-180, 180),
});
export type KernelLocationInput = v.InferOutput<
  typeof KernelLocationInputSchema
>;

/** Stored coordinate evidence. `updatedAt` is written by the Ticketing Kernel. */
export const KernelLocationSchema = v.object({
  ...KernelLocationInputSchema.entries,
  updatedAt: v.pipe(v.string(), v.check(isInstant)),
});
export type KernelLocation = v.InferOutput<typeof KernelLocationSchema>;
