"use client";

import { Web3AuthProvider, type Web3AuthContextConfig } from "@web3auth/modal/react";
import { cookieToWeb3AuthState, WEB3AUTH_NETWORK } from "@web3auth/modal";
// IMP START - Setup Wagmi Provider
import { WagmiProvider } from "@web3auth/modal/react/wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { useEffect } from "react";
import { Toaster } from "react-hot-toast";

const clientId = "BFBqhYPyPHb3b_nuvFTqJaUbUpTv-V4dw72sS2dA4Qlbvb6_iGtKYGJSjUSJGIzuDSJJh2J8sYzR0m1TQ53HJSQ"; // get from https://dashboard.web3auth.io

const queryClient = new QueryClient();
 
const web3AuthContextConfig: Web3AuthContextConfig = {
    web3AuthOptions: {
      clientId,
      web3AuthNetwork: WEB3AUTH_NETWORK.SAPPHIRE_DEVNET,
      ssr: true, // Enable SSR for session persistence across page refreshes
      // Session persistence: Web3Auth automatically saves session in cookies
      // This ensures user stays logged in after page refresh
      uiConfig: {
        defaultLanguage: "en",
        loginMethodsOrder: ["google", "twitter", "facebook", "email_passwordless", "sms_passwordless"],
      },
      modalConfig: {
        hideWalletDiscovery: true,
        connectors: {
          auth: {
            label: "Social Login",
            showOnModal: true,
            loginMethods: {
              google: { name: "Google", showOnModal: true },
              twitter: { name: "X", showOnModal: true },
              facebook: { name: "Facebook", showOnModal: true },
              email_passwordless: { name: "Email", showOnModal: true },
              sms_passwordless: { name: "Phone", showOnModal: true },
            },
          },
          metamask: {
            label: "MetaMask",
            showOnModal: false,
          },
          walletconnectv2: {
            label: "WalletConnect",
            showOnModal: false,
          },
        },
      } as any,
    }
  };

// Component to suppress hCaptcha localhost warnings in development
function ConsoleFilter({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (typeof window === "undefined" || process.env.NODE_ENV !== "development") return;

    const originalWarn = console.warn;
    const safeWarn = originalWarn.bind(console);

    const shouldSuppress = (args: unknown[]) => {
      const message = String(args[0] ?? "");
      return (
        message.includes("[hCaptcha]") ||
        message.includes("hCaptcha") ||
        message.includes("localhost detected") ||
        message.includes("Please use a valid host") ||
        (message.includes("Cross-Origin-Opener-Policy") && message.includes("window.closed"))
      );
    };

    const patchedWarn: typeof console.warn = (...args: unknown[]) => {
      if (shouldSuppress(args)) return;
      safeWarn(...args);
    };

    console.warn = patchedWarn;

    return () => {
      // Avoid clobbering if another tool/library patched console after us.
      if (console.warn === patchedWarn) console.warn = originalWarn;
    };
  }, []);

  return <>{children}</>;
}

export default function Provider({ children, cookieString }:
  { children: React.ReactNode; cookieString: string | null }) {
  const web3authInitialState = cookieToWeb3AuthState(cookieString ?? undefined);
  return (
    <ConsoleFilter>
      {/* // IMP START - SSR */}
      <Web3AuthProvider config={web3AuthContextConfig} initialState={web3authInitialState}>
        {/* // IMP END - Setup Web3Auth Provider */}
        <QueryClientProvider client={queryClient}>
          <WagmiProvider>
          {children}
          <Toaster
            position="top-right"
            toastOptions={{
              duration: 3000,
              style: {
                borderRadius: '12px',
                padding: '12px 16px',
                fontSize: '14px',
                fontWeight: '500',
                border: '1px solid rgba(0,0,0,0.1)',
                background: '#FFFFFF',
                boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
              },
              success: {
                style: {
                  background: '#ECFDF5',
                  color: '#065F46',
                  border: '1px solid #A7F3D0',
                },
                iconTheme: {
                  primary: '#10B981',
                  secondary: '#ECFDF5',
                },
              },
              error: {
                style: {
                  background: '#FEF2F2',
                  color: '#991B1B',
                  border: '1px solid #FECACA',
                },
                iconTheme: {
                  primary: '#EF4444',
                  secondary: '#FEF2F2',
                },
              },
              loading: {
                style: {
                  background: '#EFF6FF',
                  color: '#1E40AF',
                  border: '1px solid #BFDBFE',
                },
                iconTheme: {
                  primary: '#3B82F6',
                  secondary: '#EFF6FF',
                },
              },
            }}
          />
          </WagmiProvider>
        </QueryClientProvider>
        {/*// IMP START - Setup Web3Auth Provider */}
      </Web3AuthProvider>
    </ConsoleFilter>
  );
}
