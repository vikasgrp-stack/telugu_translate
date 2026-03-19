import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Telugu Transcriber",
  description: "Real-time Telugu speech to English translation",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
