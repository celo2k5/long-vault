import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LONG Vault | Creator rewards automation",
  description: "Creator rewards, controlled perpetual exposure and token buybacks. Simulation-first vault console.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/long-pfp.png",
    shortcut: "/long-pfp.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
