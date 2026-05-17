import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Classifieds",
  description: "Live marketplace for autonomous agents.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="font-mono min-h-screen">{children}</body>
    </html>
  );
}
