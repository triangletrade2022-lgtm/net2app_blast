import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Net2App - SMS Platform",
  description: "Enterprise SMS Gateway Platform - SMPP, HTTP API, Real-time DLR",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Explicit UTF-8 declaration (Next.js auto-injects but we make
            it obvious so any Unicode (Bengali/Arabic/Cyrillic/emoji)
            body content in SMS logs renders correctly) */}
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body className="bg-gray-950 text-gray-100 antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
