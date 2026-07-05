/**
 * End-to-end offline simulator: drives the emulator + oracle without any
 * Solana connection so anyone can run `npm run simulate` and watch the
 * probability curve evolve. This is an explicit visualisation tool — it
 * sets KEEPER_DRY_RUN so no on-chain submission is attempted.
 *
 * The dynamic import ensures these env flags are set before index.ts reads
 * them at module load (static imports are hoisted and would run first).
 */
process.env.KEEPER_DRY_RUN = "1";
process.env.USE_REAL_TXLINE = "0";

await import("./index.js");

export {};
