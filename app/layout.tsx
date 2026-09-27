import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WITNESS — catches failures that look correct",
  description:
    "Sidecar auditor for quiet AI failures: lies hidden in agent memory summaries, and SQL that runs but answers the wrong question.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
