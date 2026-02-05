"use client";

import { useWeb3AuthConnect, useWeb3AuthDisconnect, useWeb3AuthUser, useWalletUI, useWeb3Auth, useCheckout } from "@web3auth/modal/react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { SendTransaction } from "./wagmi/sendTransaction";
import { Balance } from "./wagmi/getBalance";
import { POLYGON_CHAIN_ID } from "./wagmi/config";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";

function App() {
  const { connect, isConnected, loading: connectLoading, error: connectError } = useWeb3AuthConnect();
  // IMP START - Logout
  const { disconnect, loading: disconnectLoading, error: disconnectError } = useWeb3AuthDisconnect();
  const { userInfo: hookUserInfo } = useWeb3AuthUser();
  const { showWalletUI, loading: walletUiLoading, error: walletUiError } = useWalletUI();
  const { showCheckout, loading: checkoutLoading, error: checkoutError } = useCheckout();
  const { provider: web3AuthProvider, web3Auth } = useWeb3Auth();
  const { address, connector } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();

  // Session restoration state: Track if we're still initializing from SSR-restored session
  // This prevents showing login screen while Web3Auth is rehydrating the session from cookies
  const [isInitializing, setIsInitializing] = useState(true);
  
  // User info state: Fetch user info directly from provider on refresh
  // useWeb3AuthUser() hook might not sync immediately on refresh, so we fetch directly
  const [userInfo, setUserInfo] = useState<any>(null);

  /**
   * FIX: Session Persistence on Page Refresh
   * 
   * Problem: On page refresh, isConnected from useWeb3AuthConnect() might be false initially
   * even though the session is restored via SSR (cookieToWeb3AuthState). This causes the
   * login screen to flash before the session is properly rehydrated.
   * 
   * Solution:
   * 1. Check for provider existence (indicates session is restored)
   * 2. Wait for Web3Auth to fully initialize before determining auth state
   * 3. Use both isConnected AND provider existence to determine if user is logged in
   * 4. Show loading state during initialization to prevent login screen flash
   * 
   * Why this works:
   * - SSR restores session via cookieToWeb3AuthState -> initialState -> Web3AuthProvider
   * - Provider exists = session was restored, just need to wait for hooks to sync
   * - isConnected might lag behind provider restoration, so we check both
   * - Once provider is ready and address exists, user is definitely logged in
   */
  /**
   * FIX: Fetch user info on session restoration
   * 
   * Problem: On page refresh, useWeb3AuthUser() hook might not immediately return user info
   * even though the session is restored. This causes profile to show default "User" / "user@example.com"
   * 
   * Solution: Fetch user info directly from Web3Auth instance when provider becomes available
   * This ensures user profile data is loaded even if the hook hasn't synced yet
   */
  useEffect(() => {
    // Wait for Web3Auth to initialize and check if session was restored
    const checkSession = async () => {
      // If provider exists, session was restored from SSR cookies
      if (web3AuthProvider) {
        try {
          // Fetch user info directly from Web3Auth instance
          // Use web3Auth from useWeb3Auth hook if available, otherwise try provider paths
          let web3AuthInstance = web3Auth;
          
          if (!web3AuthInstance) {
            // Fallback: Try to access Web3Auth through provider's internal structure
            const provider = web3AuthProvider as any;
            web3AuthInstance = 
              provider?.web3AuthInstance ||
              provider?.provider?.web3AuthInstance ||
              provider?._web3AuthInstance;
          }
          
          if (web3AuthInstance && typeof web3AuthInstance.getUserInfo === 'function') {
            const fetchedUserInfo = await web3AuthInstance.getUserInfo();
            if (fetchedUserInfo) {
              setUserInfo(fetchedUserInfo);
            }
          }
        } catch (err) {
          console.error("Error fetching user info:", err);
        }
        
        // Small delay to allow useWeb3AuthConnect hook to sync with restored provider
        await new Promise(resolve => setTimeout(resolve, 100));
        setIsInitializing(false);
      } else if (!connectLoading) {
        // If no provider and not loading, definitely not connected
        // This handles the case where there's no session to restore
        setIsInitializing(false);
      }
    };

    checkSession();
  }, [web3AuthProvider, connectLoading]);

  /**
   * Sync userInfo from hook when it becomes available
   * This ensures we use the hook's userInfo once it's loaded, but fallback to
   * directly fetched userInfo if hook is slow to sync
   */
  useEffect(() => {
    if (hookUserInfo) {
      setUserInfo(hookUserInfo);
    }
  }, [hookUserInfo]);

  /**
   * Determine actual authentication state:
   * - Provider exists = session restored (even if isConnected hasn't synced yet)
   * - isConnected = hook has synced with provider
   * - address exists = wallet is connected via Wagmi
   * User is logged in if ANY of these are true (provider is most reliable indicator)
   */
  const isAuthenticated = web3AuthProvider !== null || isConnected || address !== undefined;

  /**
   * FIX: Auto-switch to Polygon as default chain on connection
   * 
   * Problem: User might connect on ETH or other network by default
   * Solution: Automatically switch to Polygon when user connects or when chainId changes
   * This ensures Polygon is always the default chain for TopupGo
   * 
   * How it works:
   * - When user connects (isAuthenticated becomes true)
   * - Or when chainId changes and it's not Polygon
   * - Automatically switch to Polygon silently
   * - Only switch if user is connected and provider is available
   */
  useEffect(() => {
    const autoSwitchToPolygon = async () => {
      // Only switch if user is authenticated and provider is available
      if (!isAuthenticated || !web3AuthProvider || !address) {
        return;
      }

      // If already on Polygon, no need to switch
      if (chainId === POLYGON_CHAIN_ID) {
        return;
      }

      // Auto-switch to Polygon (silent, no user interaction needed)
      try {
        await switchChain({ chainId: POLYGON_CHAIN_ID });
      } catch (err) {
        // Silently fail - user might not have Polygon network added
        // Or network switch might be in progress
        console.log("Auto-switch to Polygon:", err);
      }
    };

    // Small delay to ensure everything is initialized
    const timer = setTimeout(() => {
      autoSwitchToPolygon();
    }, 500);

    return () => clearTimeout(timer);
  }, [isAuthenticated, chainId, web3AuthProvider, address, switchChain]);

  function uiConsole(...args: any[]): void {
    const el = document.querySelector("#console>p");
    if (el) {
      el.innerHTML = JSON.stringify(args || {}, null, 2);
      console.log(...args);
    }
  }

  const truncateAddress = (addr: string | undefined) => {
    if (!addr) return "";
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  // Show centered welcome toast on new login (not on page refresh)
  // Track if toast was shown to avoid showing it on session restoration
  const [hasShownWelcomeToast, setHasShownWelcomeToast] = useState(false);
  
  useEffect(() => {
    // Only show welcome toast when isConnected becomes true AND initialization is complete
    // This ensures we don't show it during session restoration from SSR
    if (isConnected && !isInitializing && !hasShownWelcomeToast) {
      // Small delay to distinguish new login from restored session
      // If provider exists immediately, it's likely a restored session
      const wasRestored = web3AuthProvider !== null;
      
      if (!wasRestored) {
        // New login - show welcome toast
        toast(
          (t) => (
            <div className="text-center">
              <p className="text-lg font-semibold text-gray-900">Welcome to TopupGo</p>
              <p className="text-sm mt-1 text-gray-600">Your account is ready</p>
            </div>
          ),
          {
            duration: 2500,
            position: 'top-center',
            style: {
              background: '#FFFFFF',
              border: '1px solid rgba(0,0,0,0.1)',
              borderRadius: '18px',
              padding: '20px 24px',
              boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
            },
          }
        );
        setHasShownWelcomeToast(true);
      } else {
        // Restored session - mark as shown to prevent toast
        setHasShownWelcomeToast(true);
      }
    }
  }, [isConnected, isInitializing, hasShownWelcomeToast, web3AuthProvider]);

  /**
   * Opens the Buy/checkout modal directly (SDK ka Buy screen) — SDK dashboard NAHI dikhata.
   * Docs: useCheckout() → showCheckout() opens "the cryptocurrency checkout modal" directly.
   * https://docs.metamask.io/embedded-wallets/sdk/react/hooks/useCheckout
   */
  const openBuyCrypto = async () => {
    try {
      if (!web3AuthProvider) {
        toast.error("Wallet not connected");
        return;
      }

      toast.loading("Opening Buy…", { id: "buy-crypto" });

      // Primary: useCheckout → showCheckout = seedha Buy modal (no SDK dashboard)
      // fiatList: sirf USD = "You Pay" USD, tokenList: sirf USDC = "You Receive" USDC (INR/USDT nahi)
      await showCheckout({
        show: true,
        fiatList: ["USD"],
        tokenList: ["USDC"],
      });

      toast.dismiss("buy-crypto");
      toast.success("Buy opened");
    } catch (err: any) {
      console.error("Error opening checkout:", err);
      toast.dismiss("buy-crypto");
      toast.error("Failed to open Buy. Please try again.");

      // Fallback: showWalletUI with funding path (can show dashboard first)
      try {
        showWalletUI({ show: true, path: "wallet/funding" });
      } catch (fallbackErr) {
        console.error("Fallback also failed:", fallbackErr);
      }
    }
  };

  // Keep handleTopUp for backward compatibility, but use openBuyCrypto internally
  const handleTopUp = openBuyCrypto;

  const loggedInView = (
    <div className="min-h-screen">
      {/* Top Navigation Bar */}
      <nav className="w-full border-b" style={{ borderColor: 'rgba(0,0,0,0.08)', backgroundColor: 'rgba(255,255,255,0.5)', backdropFilter: 'blur(10px)' }}>
        <div className="mx-auto max-w-7xl px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ backgroundColor: '#111827' }}>
                <svg className="h-5 w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h1 className="text-xl font-semibold" style={{ color: '#111827' }}>TopupGo</h1>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 rounded-full px-3 py-1.5 border" style={{ backgroundColor: 'rgba(16, 185, 129, 0.1)', borderColor: 'rgba(16, 185, 129, 0.2)' }}>
                <div className="h-2 w-2 rounded-full bg-green-500"></div>
                <span className="text-sm font-medium" style={{ color: '#059669' }}>Connected</span>
              </div>
              <button
                onClick={() => disconnect()}
                className="flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors hover:opacity-90"
                style={{ borderColor: 'rgba(0,0,0,0.1)', color: '#111827', backgroundColor: 'rgba(255,255,255,0.8)' }}
                disabled={disconnectLoading}
              >
                {disconnectLoading ? "Disconnecting..." : "Log Out"}
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </button>
              {disconnectError && <div className="text-sm text-red-600">{disconnectError.message}</div>}
            </div>
          </div>
        </div>
      </nav>

      {/* Main Dashboard Content - 2x2 Grid */}
      <div className="mx-auto max-w-7xl px-6 py-8">
        {/* TOP ROW */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 mb-6">
          {/* Left: Available Balance */}
          <Balance />
          
          {/* Right: Top Up */}
          <div className="rounded-[18px] bg-white p-6" style={{ boxShadow: '0 4px 20px rgba(0,0,0,0.08)' }}>
            <div className="mb-4 flex items-center gap-2">
              <svg className="h-5 w-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <h2 className="text-lg font-semibold text-gray-900">Top Up</h2>
            </div>
            <div className="mb-6 flex justify-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-blue-50">
                <svg className="h-8 w-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
              </div>
            </div>
            <p className="mb-6 text-center text-sm text-gray-600">
              Add funds to your TopupGo account
            </p>
            <button
              onClick={handleTopUp}
              className="w-full rounded-lg px-4 py-3 text-sm font-medium text-white transition-all hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: '#111827' }}
              disabled={checkoutLoading || walletUiLoading}
            >
              {checkoutLoading || walletUiLoading ? "Opening Buy…" : "Top Up USD"}
            </button>
            {(checkoutError || walletUiError) && (
              <div className="mt-2 text-sm text-red-600">{(checkoutError || walletUiError)?.message}</div>
            )}
          </div>
        </div>

        {/* SECOND ROW */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Left: Send Payment */}
          <div className="rounded-[18px] bg-white p-6" style={{ boxShadow: '0 4px 20px rgba(0,0,0,0.08)' }}>
            <SendTransaction />
          </div>
          
          {/* Right: Profile */}
          <div className="rounded-[18px] bg-white p-6" style={{ boxShadow: '0 4px 20px rgba(0,0,0,0.08)' }}>
            <div className="mb-4 flex items-center gap-2">
              <svg className="h-5 w-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              <h2 className="text-lg font-semibold text-gray-900">Profile</h2>
            </div>
            <div className="mb-4 flex justify-center">
              {userInfo?.profileImage ? (
                <img
                  src={userInfo.profileImage}
                  alt="Profile"
                  className="h-20 w-20 rounded-full object-cover ring-2 ring-gray-200"
                />
              ) : (
                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gray-100">
                  <svg className="h-10 w-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                </div>
              )}
            </div>
            <div className="mb-2 text-center">
              <p className="text-base font-semibold text-gray-900">
                {userInfo?.name || "User"}
              </p>
            </div>
            <div className="mb-4 text-center">
              <p className="text-sm text-gray-600">
                {userInfo?.email || "user@example.com"}
              </p>
            </div>
            {/* <button
              onClick={() => uiConsole(userInfo)}
              className="w-full rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              View Profile
            </button> */}
          </div>
        </div>
      </div>

      <div id="console" className="hidden">
        <p></p>
      </div>
    </div>
  );

  const unloggedInView = (
    <div className="flex min-h-screen items-center justify-center">
      <div className="rounded-[18px] bg-white p-8 w-full max-w-md" style={{ boxShadow: '0 4px 20px rgba(0,0,0,0.08)' }}>
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-lg" style={{ backgroundColor: '#111827' }}>
            <svg className="h-8 w-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h1 className="mb-2 text-2xl font-semibold text-gray-900">TopupGo</h1>
          <p className="text-gray-600">Sign in to access your account</p>
        </div>
        <button
          onClick={() => connect()}
          className="w-full rounded-lg px-6 py-3 text-base font-medium text-white transition-all hover:opacity-90 disabled:opacity-50"
          style={{ backgroundColor: '#111827' }}
          disabled={connectLoading}
        >
          {connectLoading ? "Connecting..." : "Sign In"}
        </button>
        {connectError && <div className="mt-4 text-center text-sm text-red-600">{connectError.message}</div>}
      </div>
    </div>
  );

  // Show loading state during initialization to prevent login screen flash
  // This happens when session is being restored from SSR cookies
  if (isInitializing) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-gray-900"></div>
          <p className="text-sm text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  // Use isAuthenticated instead of just isConnected
  // This ensures restored sessions are recognized even if hook hasn't synced yet
  if (!isAuthenticated) {
    return unloggedInView;
  }

  return loggedInView;
}

export default App;
