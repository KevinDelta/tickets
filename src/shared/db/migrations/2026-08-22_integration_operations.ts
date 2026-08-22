import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-08-22_integration_operations",
  "Record authenticated integration mutations and their idempotent outcomes",
  {
    indexes: [
      "idx_integration_operations_booking",
      "idx_integration_operations_idempotency",
      "idx_integration_operations_ticket",
    ],
    newTables: ["integration_operations"],
  },
);
