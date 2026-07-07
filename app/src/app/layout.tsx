import "./globals.css";
import type { Metadata } from "next";
import React from "react";
import { DM_Sans, Bricolage_Grotesque } from "next/font/google";
import { SolanaProviders } from "@/components/WalletProvider";
import { WalletButton } from "@/components/WalletButton";

const sans = DM_Sans({ subsets: ["latin"], variable: "--font-sans" });
const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["600", "700", "800"],
});

export const metadata: Metadata = {
  title: "TabulaMarkets",
  description:
    "Devnet demo of an LMSR prop market priced by a TabFM oracle. Bets and settlement are stubbed.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable}`}>
      <body className="min-h-screen font-sans text-ink antialiased">
        <SolanaProviders>
          <div className="max-w-6xl mx-auto px-5 pb-10">
            <header className="flex items-center justify-between gap-4 py-6 mb-8">
              <div className="flex items-center gap-3">
                <div
                  aria-hidden="true"
                  className="h-12 w-12 rounded-blob bg-ink text-sun grid place-items-center text-2xl shadow-pop animate-floaty select-none"
                >
                  👻
                </div>
                <div>
                  <h1 className="font-display text-2xl font-extrabold tracking-tight leading-none">
                    Tabula<span className="text-cream drop-shadow-[0_2px_0_rgba(28,28,28,.25)]">Markets</span>
                  </h1>
                  <p className="text-xs font-semibold text-ink/60 mt-1">
                    Prop market demo · Solana devnet · bets not wired
                  </p>
                </div>
              </div>
              <WalletButton />
            </header>
            {children}
            <footer className="mt-16 flex items-center justify-center">
              <p className="rounded-full bg-ink/10 px-4 py-2 text-xs font-semibold text-ink/70">
                No real money · devnet only · Apache-2.0
              </p>
            </footer>
          </div>
        </SolanaProviders>
      </body>
    </html>
  );
}
