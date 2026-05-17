import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Event-type accent palette — used by ticker chips.
        evt: {
          register: "#60a5fa",
          posted: "#a78bfa",
          bid: "#f472b6",
          contract: "#34d399",
          payment: "#facc15",
          completed: "#22d3ee",
          llm: "#f87171",
          metric: "#94a3b8",
          assigned: "#fbbf24",
          timeout: "#ef4444",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
