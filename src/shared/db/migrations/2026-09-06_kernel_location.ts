import { schemaMigration } from "./define.ts";

/** Store optional Kernel-authored WGS84 evidence separately from display text. */
export default schemaMigration(
  "2026-09-06_kernel_location",
  "Add the Kernel-authored WGS84 location evidence column to listings.",
  { columns: { listings: ["kernel_location"] } },
);
