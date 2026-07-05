import "./globals.css";
import type { Metadata } from "next";
import React from "react";
import { SolanaProviders } from "@/components/WalletProvider";
import { WalletButton } from "@/components/WalletButton";

export const metadata: Metadata = {
  title: "TabulaMarkets",
  description: "AI-Driven AMM and Cryptographic Solana Settlement for Dynamic Prop Bets",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-mono">
        <SolanaProviders>
          <div className="max-w-6xl mx-auto p-6">
            <header className="flex items-center justify-between py-4 border-b border-white/10 mb-6">
              <div>
                <h1 className="text-xl font-bold tracking-tight">
                  Tabula<span className="text-accent">Markets</span>
                </h1>
                <p className="text-xs text-white/50">
                  AI-driven prop-bet AMM · Solana devnet · TxLINE settled
                </p>
              </div>
              <WalletButton />
            </header>
            {children}
            <footer className="mt-16 pt-6 border-t border-white/10 text-xs text-white/40">
              Not for use with real funds · devnet only · Apache-2.0
            </footer>
          </div>
        </SolanaProviders>
      </body>
    </html>
  );
}
