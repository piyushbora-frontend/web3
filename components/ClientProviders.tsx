"use client";

import dynamic from "next/dynamic";

const Provider = dynamic(() => import("./provider"), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 text-gray-600">
      Loading…
    </div>
  ),
});

export default function ClientProviders({
  children,
  cookieString,
}: {
  children: React.ReactNode;
  cookieString: string | null;
}) {
  return <Provider cookieString={cookieString}>{children}</Provider>;
}
