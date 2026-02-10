"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useWeb3AuthDisconnect, useWeb3AuthUser } from "@web3auth/modal/react";

const PROFILE_IMAGE_FALLBACK = "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d";

function getStringField(source: unknown, key: string): string | null {
  if (!source || typeof source !== "object") return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export default function ProfilePage() {
  const { userInfo } = useWeb3AuthUser();
  const { disconnect, loading: disconnectLoading } = useWeb3AuthDisconnect();

  const profile = useMemo(() => {
    const profileImageFromSdk = getStringField(userInfo, "profileImage");
    const image = profileImageFromSdk || PROFILE_IMAGE_FALLBACK;
    const name = userInfo?.name || "User";
    const email = userInfo?.email || "user@example.com";
    const username =
      getStringField(userInfo, "username") ||
      getStringField(userInfo, "verifierId") ||
      (email ? email.split("@")[0] : "user");
    const idRaw = getStringField(userInfo, "id") || getStringField(userInfo, "verifierId") || "8F2A7C3D";
    const shortId = String(idRaw).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase();

    return { name, email, image, username, shortId };
  }, [userInfo]);

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-7xl px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-50"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to dashboard
          </Link>
          <button
            onClick={() => disconnect()}
            className="rounded-lg border px-4 py-2 text-sm font-medium transition-colors hover:opacity-90"
            style={{ borderColor: "rgba(0,0,0,0.1)", color: "#111827", backgroundColor: "rgba(255,255,255,0.8)" }}
            disabled={disconnectLoading}
          >
            {disconnectLoading ? "Logging out..." : "Log Out"}
          </button>
        </div>

        <div className="rounded-[18px] bg-white p-6" style={{ boxShadow: "0 4px 20px rgba(0,0,0,0.08)" }}>
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <img
              src={profile.image}
              alt={profile.name}
              className="h-16 w-16 rounded-full object-cover ring-2 ring-gray-100"
            />
            <div>
              <p className="text-lg font-medium text-gray-900">{profile.name}</p>
              <p className="text-sm text-gray-500">{profile.email}</p>
              <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
                <span className="h-2 w-2 rounded-full bg-green-500"></span>
                Connected
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-[18px] bg-white p-5" style={{ boxShadow: "0 4px 20px rgba(0,0,0,0.06)" }}>
            <p className="text-xs uppercase tracking-wide text-gray-400">Username</p>
            <p className="mt-2 text-sm font-medium text-gray-900">{profile.username}</p>
          </div>
          <div className="rounded-[18px] bg-white p-5" style={{ boxShadow: "0 4px 20px rgba(0,0,0,0.06)" }}>
            <p className="text-xs uppercase tracking-wide text-gray-400">Login Method</p>
            <p className="mt-2 text-sm font-medium text-gray-900">Google</p>
          </div>
          <div className="rounded-[18px] bg-white p-5" style={{ boxShadow: "0 4px 20px rgba(0,0,0,0.06)" }}>
            <p className="text-xs uppercase tracking-wide text-gray-400">User ID</p>
            <p className="mt-2 text-sm font-medium text-gray-900">{profile.shortId}</p>
          </div>
          <div className="rounded-[18px] bg-white p-5" style={{ boxShadow: "0 4px 20px rgba(0,0,0,0.06)" }}>
            <p className="text-xs uppercase tracking-wide text-gray-400">Joined Date</p>
            <p className="mt-2 text-sm font-medium text-gray-900">Jan 2024</p>
          </div>
        </div>
      </div>
    </div>
  );
}
