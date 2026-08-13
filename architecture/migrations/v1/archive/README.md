# Historical pre-outbox migration archive

These eighteen canonical SQL artifacts were present in the immutable predecessor
image. Fifteen are absent from the current checked-in Prisma migration directory;
three intentionally supersede exact, hard-pinned noncanonical source variants
with the same migration names. They are preserved here solely for the 62-row
production migration authority and its isolated replay proof. Prisma must never
discover this directory during normal application migration execution; the
replay tool explicitly stages only canonical artifacts in a temporary migration
directory after exact checksum validation.
