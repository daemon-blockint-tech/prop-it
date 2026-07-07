"use client";

import dynamic from "next/dynamic";

// Load the wallet button client-side only: it reads browser wallet globals
// and must not be server-rendered.
export const WalletButton = dynamic(
  async () =>
    (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false, loading: () => <span className="text-xs font-semibold text-ink/50">wallet…</span> },
);
