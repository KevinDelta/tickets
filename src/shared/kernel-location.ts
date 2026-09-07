/** Kernel-owned WGS84 location evidence published to authorized consumers. */

import * as v from "valibot";
import { isInstant } from "#shared/validation/timestamp.ts";

const latitude = v.pipe(
  v.number(),
  v.finite(),
  v.minValue(-90),
  v.maxValue(90),
);
const longitude = v.pipe(
  v.number(),
  v.finite(),
  v.minValue(-180),
  v.maxValue(180),
);

/** Coordinates an authenticated operator may set. Freshness is server-owned. */
export const KernelLocationInputSchema = v.object({ latitude, longitude });
export type KernelLocationInput = v.InferOutput<
  typeof KernelLocationInputSchema
>;

/** Stored coordinate evidence. `updatedAt` is written by the Ticketing Kernel. */
export const KernelLocationSchema = v.object({
  ...KernelLocationInputSchema.entries,
  updatedAt: v.pipe(v.string(), v.check(isInstant)),
});
export type KernelLocation = v.InferOutput<typeof KernelLocationSchema>;
