import type { Config } from "tailwindcss";
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Phantom-inspired palette
        lavender: "#AB9FF2",
        "lavender-deep": "#8C7DE8",
        ink: "#1C1C1C",
        cream: "#FFFDF8",
        card: "#FFFFFF",
        sun: "#FFDC62",
        mint: "#2EC08B",
        "mint-deep": "#178F63", // AA-contrast mint for text on light
        peach: "#FF7243",
        blush: "#FFD3C9",
        sky: "#9CD2FF",
        // kept for legacy class names
        panel: "#FFFFFF",
        accent: "#8C7DE8",
        danger: "#E5484D",
        "danger-deep": "#C4292E", // AA-contrast danger for text on light
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "var(--font-sans)", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: {
        blob: "1.75rem",
      },
      boxShadow: {
        pop: "0 1px 0 rgba(28,28,28,.04), 0 8px 24px rgba(76,58,180,.14)",
        "pop-lg": "0 2px 0 rgba(28,28,28,.04), 0 16px 40px rgba(76,58,180,.18)",
        press: "inset 0 -3px 0 rgba(0,0,0,.12)",
      },
      keyframes: {
        floaty: {
          "0%,100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-4px)" },
        },
      },
      animation: {
        floaty: "floaty 3s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
export default config;
