import "./globals.css";
import React from "react";
import ClientProviders from "../components/ClientProviders";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
// Server-only: must run before any code that may use localStorage (e.g. Web3Auth)
import "../lib/server-localStorage-polyfill";

const inter = Inter({ subsets: ["latin"] });

export const metadata = {
  title: "Web3Auth NextJS Quick Start",
  description: "Web3Auth NextJS Quick Start",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const headersList = await headers();
  const cookieString = headersList.get("cookie") ?? null;
  return (
    <html lang="en">
      <body className={inter.className}>
        <ClientProviders cookieString={cookieString}>{children}</ClientProviders>
      </body>
    </html>
  );
}
