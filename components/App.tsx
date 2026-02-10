"use client";

import { useWeb3AuthConnect, useWeb3AuthDisconnect, useWeb3AuthUser, useWalletUI, useWeb3Auth, useCheckout } from "@web3auth/modal/react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { SendTransaction } from "./wagmi/sendTransaction";
import { Balance } from "./wagmi/getBalance";
import { TransactionHistorySection } from "./dashboard/TransactionHistorySection";
import { POLYGON_CHAIN_ID } from "./wagmi/config";
import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { loggedFetch } from "../lib/loggedFetch";

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
  const [balanceRefreshTrigger, setBalanceRefreshTrigger] = useState(0);
  const [showProfileDetails, setShowProfileDetails] = useState(false);
  const [isDarkTheme, setIsDarkTheme] = useState(true);
  const handlePaymentSuccess = useCallback(() => setBalanceRefreshTrigger((n) => n + 1), []);
  const lastAccountSyncKey = useRef<string | null>(null);
  const hasCreatedAccountRef = useRef(false);
  const hasFetchedAccountsRef = useRef(false);
  const accountSyncInFlight = useRef(false);
  const lastWalletSyncKey = useRef<string | null>(null);
  const walletSyncInFlight = useRef(false);
  const accountSyncJustCompleted = useRef(false);

  const ACCOUNTS_API = "https://api.topupgo.org/api/accounts/";
  const ACCOUNTS_EXISTS_API = "https://api.topupgo.org/api/account/exists/";
  const WALLETS_API = "https://api.topupgo.org/api/wallets/";
  const TOPUPGO_CSRF_TOKEN = process.env.NEXT_PUBLIC_TOPUPGO_CSRF_TOKEN;

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
   * Sync wallet address to backend after account creation
   * This function sends wallet address and account info to WALLETS_API
   * 
   * Flow:
   * 1. Check if accessToken and address are available
   * 2. Prevent duplicate calls using lastWalletSyncKey
   * 3. POST to WALLETS_API with proper headers
   * 4. Handle errors gracefully
   */
  const syncWalletToBackend = async (accessToken: string, walletAddress: string, accountId?: number) => {
    // Prevent duplicate calls - track by address only (not token, as token might change)
    const walletSyncKey = walletAddress.toLowerCase();
    if (lastWalletSyncKey.current === walletSyncKey) {
      console.log("[Wallet Sync] SKIPPED: Already synced for this address", walletAddress);
      return;
    }

    if (walletSyncInFlight.current) {
      console.log("[Wallet Sync] SKIPPED: Sync already in progress");
      return;
    }

    if (!accessToken || !walletAddress) {
      console.error("[Wallet Sync] SKIPPED: Missing accessToken or walletAddress", {
        hasAccessToken: !!accessToken,
        hasWalletAddress: !!walletAddress,
      });
      return;
    }

    walletSyncInFlight.current = true;
    lastWalletSyncKey.current = walletSyncKey;

    console.log("[Wallet Sync] STARTING", {
      walletAddress,
      accountId: accountId || "NOT_PROVIDED",
      hasAccessToken: !!accessToken,
    });

    try {
      // Build payload - only include account if we have a valid accountId
      const walletPayload: any = {
        address: walletAddress,
        wallet_type: "metamask_embedded",
        balance: 0,
      };

      // Only add account field if we have a valid accountId (not 0 or undefined)
      if (accountId && accountId > 0) {
        walletPayload.account = accountId;
      } else {
        // If no accountId, backend might infer it from the token
        // But let's try with 0 as per Postman example
        walletPayload.account = 0;
      }

      console.log("[Wallet Sync] Payload:", JSON.stringify(walletPayload, null, 2));

      const walletRes = await loggedFetch(WALLETS_API, {
        method: "POST",
        headers: {
          accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...(TOPUPGO_CSRF_TOKEN ? { "X-CSRFTOKEN": TOPUPGO_CSRF_TOKEN } : {}),
        },
        body: JSON.stringify(walletPayload),
        logLabel: "TopupGo wallet create",
      });

      if (!walletRes.ok) {
        // Read error response - backend might return JSON or text
        let errorText = "";
        let errorJson: any = null;
        
        try {
          // Clone to read as text (we'll try JSON parsing on the text)
          const clonedRes = walletRes.clone();
          errorText = await clonedRes.text();
          
          // Try to parse as JSON
          if (errorText) {
            try {
              errorJson = JSON.parse(errorText);
            } catch {
              // Not JSON, keep as text
            }
          }
        } catch (err) {
          errorText = `Status ${walletRes.status}: ${walletRes.statusText}`;
          console.error("[Wallet Sync] Could not read error response", err);
        }
        
        console.error("[Wallet Sync] ❌ FAILED - Full Error Details:", {
          status: walletRes.status,
          statusText: walletRes.statusText,
          errorText: errorText,
          errorJson: errorJson,
          payload: walletPayload,
          url: WALLETS_API,
        });
        
        // Check if wallet already exists (might be OK)
        const errorMessage = errorText || JSON.stringify(errorJson || {});
        const alreadyExists =
          walletRes.status === 400 &&
          (errorMessage.includes("already exists") ||
            errorMessage.includes("Wallet with this address already exists") ||
            errorMessage.includes("duplicate") ||
            (errorJson && (
              String(errorJson.message || "").toLowerCase().includes("already exists") ||
              String(errorJson.error || "").toLowerCase().includes("already exists") ||
              String(errorJson.detail || "").toLowerCase().includes("already exists")
            )));

        if (alreadyExists) {
          console.log("[Wallet Sync] ✅ Wallet already exists (OK) - Marking as synced", {
            status: walletRes.status,
            response: errorJson || errorText,
          });
          // Mark as synced even if it already exists
          return;
        }

        // For other 400 errors, log detailed error but don't retry
        console.error("[Wallet Sync] ⚠️ Validation Error - Check payload format and backend requirements", {
          status: walletRes.status,
          error: errorJson || errorText,
          sentPayload: walletPayload,
        });
        return;
      }

      const walletJson = await walletRes.json().catch(() => null);
      console.log("[Wallet Sync] ✅ SUCCESS", {
        response: walletJson,
        walletId: walletJson?.id,
        accountId: walletJson?.account,
      });
    } catch (err) {
      console.error("[Wallet Sync] EXCEPTION", err);
      // Reset the flag on exception so it can be retried
      walletSyncInFlight.current = false;
      lastWalletSyncKey.current = null;
    } finally {
      walletSyncInFlight.current = false;
    }
  };

  useEffect(() => {
    const syncAccount = async () => {
      if (!isAuthenticated || !userInfo) return;

      const email = userInfo?.email || "";
      const rawName = userInfo?.name || "";
      const [firstName, ...restName] = rawName.split(" ").filter(Boolean);
      const lastName = restName.join(" ");
      const username =
        (userInfo as any)?.username ||
        (userInfo as any)?.verifierId ||
        (email ? email.split("@")[0] : "");
      const phoneNo =
        (userInfo as any)?.phone_no ||
        (userInfo as any)?.phoneNumber ||
        (userInfo as any)?.phone ||
        "";
      const dateOfBirth = (userInfo as any)?.date_of_birth || (userInfo as any)?.dateOfBirth || "";

      const syncKey = `${email}|${username}|${phoneNo}|${dateOfBirth}`;
      if (lastAccountSyncKey.current === syncKey) return;
      if (hasCreatedAccountRef.current || accountSyncInFlight.current) return;
      accountSyncInFlight.current = true;
      hasCreatedAccountRef.current = true;
      lastAccountSyncKey.current = syncKey;
      console.log("ACCOUNT_CREATE_TRIGGERED_ONCE");

      const payload = {
        email,
        username,
        phone_no: phoneNo,
        first_name: firstName || "",
        last_name: lastName || "",
        date_of_birth: dateOfBirth,
        is_verified: true,
      };
      console.log("[TopupGo] account details", payload);

      try {
        const fetchAccountId = async () => {
          const candidates: Array<string> = [];
          if (email) candidates.push(`${ACCOUNTS_API}?email=${encodeURIComponent(email)}`);
          if (username) candidates.push(`${ACCOUNTS_API}?username=${encodeURIComponent(username)}`);

          for (const url of candidates) {
            try {
              const res = await loggedFetch(url, {
                headers: {
                  accept: "application/json",
                  ...(TOPUPGO_CSRF_TOKEN ? { "X-CSRFTOKEN": TOPUPGO_CSRF_TOKEN } : {}),
                },
                logLabel: "TopupGo account lookup",
              });
              if (!res.ok) continue;
              const data = await res.json().catch(() => null);
              const list = Array.isArray(data)
                ? data
                : Array.isArray(data?.results)
                  ? data.results
                  : Array.isArray(data?.data)
                    ? data.data
                    : [];
              const first = list[0];
              const id = first?.id ?? first?.account?.id;
              if (id) return id;
            } catch {
              // ignore and try next candidate
            }
          }
          return null;
        };

        const res = await loggedFetch(ACCOUNTS_API, {
          method: "POST",
          headers: {
            accept: "application/json",
            "Content-Type": "application/json",
            ...(TOPUPGO_CSRF_TOKEN ? { "X-CSRFTOKEN": TOPUPGO_CSRF_TOKEN } : {}),
          },
          body: JSON.stringify(payload),
          logLabel: "TopupGo account create",
        });

        if (!res.ok) {
          const text = await res.text();
          const alreadyExists =
            res.status === 400 &&
            (text.includes("already exists") ||
              text.includes("Account with this email already exists") ||
              text.includes("Account with this username already exists"));

          if (alreadyExists) {
            let accessTokenFromExists: string | null = null;
            if (email) {
              try {
                const existsRes = await loggedFetch(
                  `${ACCOUNTS_EXISTS_API}?email=${encodeURIComponent(email)}`,
                  {
                    headers: {
                      accept: "application/json",
                      ...(TOPUPGO_CSRF_TOKEN ? { "X-CSRFTOKEN": TOPUPGO_CSRF_TOKEN } : {}),
                    },
                    logLabel: "TopupGo account exists",
                  }
                );
                const existsJson = await existsRes.json().catch(() => null);
                accessTokenFromExists = existsJson?.access_token ?? null;
              } catch (err) {
                console.error("Account exists check failed:", err);
              }
            }

            const existingId = await fetchAccountId();
            if (existingId) {
              lastAccountSyncKey.current = syncKey;
            }

            if (!hasFetchedAccountsRef.current && accessTokenFromExists) {
              hasFetchedAccountsRef.current = true;
              console.log("ACCOUNT_GET_TRIGGERED_ONCE");
              const listRes = await loggedFetch(ACCOUNTS_API, {
                headers: {
                  accept: "application/json",
                  ...(TOPUPGO_CSRF_TOKEN ? { "X-CSRFTOKEN": TOPUPGO_CSRF_TOKEN } : {}),
                  Authorization: `Bearer ${accessTokenFromExists}`,
                },
                logLabel: "TopupGo account list (existing account)",
              });
              const listJson = await listRes.json().catch(() => null);
              console.log("ACCOUNT_LIST_RESPONSE", listJson);
            }

            // Sync wallet for existing account if address is available
            if (accessTokenFromExists && address) {
              console.log("[Wallet Sync] Triggering for existing account");
              // Get account ID from the list response if available
              const listRes = await loggedFetch(ACCOUNTS_API, {
                headers: {
                  accept: "application/json",
                  ...(TOPUPGO_CSRF_TOKEN ? { "X-CSRFTOKEN": TOPUPGO_CSRF_TOKEN } : {}),
                  Authorization: `Bearer ${accessTokenFromExists}`,
                },
                logLabel: "TopupGo account list (for wallet sync)",
              }).catch(() => null);
              
              let accountIdForWallet: number | undefined = undefined;
              if (listRes?.ok) {
                const listJson = await listRes.json().catch(() => null);
                const accountList = Array.isArray(listJson)
                  ? listJson
                  : Array.isArray(listJson?.results)
                    ? listJson.results
                    : Array.isArray(listJson?.data)
                      ? listJson.data
                      : [];
                const firstAccount = accountList[0];
                accountIdForWallet = firstAccount?.id ?? firstAccount?.account?.id;
              }

              // Sync wallet with existing account's access token
              await syncWalletToBackend(accessTokenFromExists, address, accountIdForWallet);
            }

            return;
          }

          console.error("Account sync failed:", res.status, text);
          return;
        }

        const accountJson = await res.json().catch(() => null);
        console.log("ACCOUNT_CREATE_RESPONSE", accountJson);
        const accountId = accountJson?.id ?? accountJson?.data?.id ?? accountJson?.account?.id;
        const accessToken = accountJson?.access_token ?? accountJson?.data?.access_token;

        if (!accessToken) {
          console.error("ACCOUNT_CREATE_ERROR: access_token missing from response");
          return;
        }

        // Sync wallet to backend after account creation
        // Wait for wallet address to be available if not already
        if (address) {
          console.log("[Wallet Sync] Triggering after account creation");
          accountSyncJustCompleted.current = true;
          await syncWalletToBackend(accessToken, address, accountId);
          // Reset flag after a delay to allow useEffect to check it
          setTimeout(() => {
            accountSyncJustCompleted.current = false;
          }, 3000);
        } else {
          console.log("[Wallet Sync] WAITING: Wallet address not available yet, will sync when address is ready");
        }

        if (!hasFetchedAccountsRef.current) {
          hasFetchedAccountsRef.current = true;
          console.log("ACCOUNT_GET_TRIGGERED_ONCE");
          const listRes = await loggedFetch(ACCOUNTS_API, {
            headers: {
              accept: "application/json",
              ...(TOPUPGO_CSRF_TOKEN ? { "X-CSRFTOKEN": TOPUPGO_CSRF_TOKEN } : {}),
              Authorization: `Bearer ${accessToken}`,
            },
            logLabel: "TopupGo account list",
          });
          const listJson = await listRes.json().catch(() => null);
          console.log("ACCOUNT_LIST_RESPONSE", listJson);
        }
      } catch (err) {
        console.error("Account sync error:", err);
      } finally {
        accountSyncInFlight.current = false;
      }
    };

    syncAccount();
  }, [isAuthenticated, userInfo, address]);

  /**
   * Separate effect to sync wallet when address becomes available
   * This handles the case where account is created but wallet address is not yet available
   * It also handles wallet sync on page refresh when account already exists
   * 
   * IMPORTANT: This only runs if wallet hasn't been synced yet (checked by lastWalletSyncKey)
   */
  useEffect(() => {
    // Skip if wallet already synced for this address
    if (address && lastWalletSyncKey.current === address.toLowerCase()) {
      return;
    }

    // Skip if sync is in progress
    if (walletSyncInFlight.current) {
      return;
    }

    // Skip if account sync just completed (wallet sync will happen in account sync flow)
    if (accountSyncJustCompleted.current) {
      console.log("[Wallet Sync] SKIPPED: Account sync just completed, wallet sync will happen in account flow");
      return;
    }

    const syncWalletWhenReady = async () => {
      // Only proceed if authenticated and address is available
      if (!isAuthenticated || !address || !userInfo) return;

      // Double-check: Skip if already synced
      if (lastWalletSyncKey.current === address.toLowerCase()) {
        console.log("[Wallet Sync] SKIPPED: Already synced for this address (double-check)");
        return;
      }

      // Check if we have an access token stored or can get it
      // For existing accounts, we need to fetch access token
      const email = userInfo?.email || "";
      if (!email) {
        console.log("[Wallet Sync] SKIPPED: No email in userInfo");
        return;
      }

      // Try to get access token for existing account
      let accessToken: string | null = null;
      try {
        const existsRes = await loggedFetch(
          `${ACCOUNTS_EXISTS_API}?email=${encodeURIComponent(email)}`,
          {
            headers: {
              accept: "application/json",
              ...(TOPUPGO_CSRF_TOKEN ? { "X-CSRFTOKEN": TOPUPGO_CSRF_TOKEN } : {}),
            },
            logLabel: "TopupGo account exists (for wallet sync)",
          }
        );
        const existsJson = await existsRes.json().catch(() => null);
        accessToken = existsJson?.access_token ?? null;
      } catch (err) {
        console.log("[Wallet Sync] Could not fetch access token, wallet sync will happen after account creation");
        return;
      }

      if (!accessToken) {
        console.log("[Wallet Sync] SKIPPED: No access token available");
        return;
      }

      // Get account ID - this is important for the wallet POST API
      let accountId: number | undefined = undefined;
      try {
        const listRes = await loggedFetch(ACCOUNTS_API, {
          headers: {
            accept: "application/json",
            ...(TOPUPGO_CSRF_TOKEN ? { "X-CSRFTOKEN": TOPUPGO_CSRF_TOKEN } : {}),
            Authorization: `Bearer ${accessToken}`,
          },
          logLabel: "TopupGo account list (for wallet sync)",
        });
        if (listRes.ok) {
          const listJson = await listRes.json().catch(() => null);
          const accountList = Array.isArray(listJson)
            ? listJson
            : Array.isArray(listJson?.results)
              ? listJson.results
              : Array.isArray(listJson?.data)
                ? listJson.data
                : [];
          const firstAccount = accountList[0];
          accountId = firstAccount?.id ?? firstAccount?.account?.id;
          console.log("[Wallet Sync] Fetched account ID:", accountId);
        }
      } catch (err) {
        console.log("[Wallet Sync] Could not fetch account ID, will use 0 as fallback");
      }

      // Sync wallet
      await syncWalletToBackend(accessToken, address, accountId);
    };

    // Delay to ensure account sync has completed first
    // Only run if address is available and not already synced
    if (address && !lastWalletSyncKey.current) {
      const timer = setTimeout(() => {
        syncWalletWhenReady();
      }, 2000); // Increased delay to ensure account sync completes

      return () => clearTimeout(timer);
    }
  }, [isAuthenticated, address, userInfo]);

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
    <div className={`min-h-screen ${isDarkTheme ? 'bg-[#0B0D12] text-gray-100' : 'bg-gray-50 text-gray-900'}`}>
      {/* Top Navigation Bar */}
      <nav className={`w-full border-b ${isDarkTheme ? 'border-white/10 bg-[#0E1118]' : 'border-gray-200 bg-white'}`}>
        <div className="mx-auto max-w-7xl px-3 sm:px-6 py-3 sm:py-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-shrink">
              <div className="flex h-7 w-7 sm:h-8 sm:w-8 items-center justify-center rounded-lg bg-[#5B5DF0] flex-shrink-0">
                <svg className="h-4 w-4 sm:h-5 sm:w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="min-w-0">
                <h1 className={`text-base sm:text-xl font-semibold truncate ${isDarkTheme ? 'text-white' : 'text-gray-900'}`}>TopupGo</h1>
                <p className={`text-[10px] sm:text-[11px] uppercase tracking-[0.14em] hidden xs:block ${isDarkTheme ? 'text-gray-400' : 'text-gray-500'}`}>Dashboard</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 sm:gap-4 flex-shrink-0">
              <div className={`hidden sm:flex items-center gap-2 rounded-full border px-2 sm:px-3 py-1 sm:py-1.5 ${isDarkTheme ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-emerald-200 bg-emerald-50'}`}>
                <div className="h-2 w-2 rounded-full bg-green-500"></div>
                <span className={`text-xs sm:text-sm font-medium ${isDarkTheme ? 'text-emerald-300' : 'text-emerald-700'}`}>Connected</span>
              </div>
              <div className="sm:hidden flex items-center gap-1 rounded-full border px-1.5 py-1">
                <div className="h-1.5 w-1.5 rounded-full bg-green-500"></div>
              </div>
              <button
                onClick={() => setIsDarkTheme((prev) => !prev)}
                className={`flex items-center justify-center rounded-lg border p-1.5 sm:p-2 transition-colors ${isDarkTheme ? 'border-white/15 bg-white/5 text-gray-300 hover:bg-white/10' : 'border-gray-300 bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                title={isDarkTheme ? "Switch to light theme" : "Switch to dark theme"}
              >
                {isDarkTheme ? (
                  <svg className="h-4 w-4 sm:h-5 sm:w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4 sm:h-5 sm:w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                  </svg>
                )}
              </button>
              <button
                onClick={() => disconnect()}
                className={`flex items-center gap-1 sm:gap-2 rounded-lg border px-2 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-medium transition-colors ${isDarkTheme ? 'border-white/15 bg-white text-gray-900 hover:bg-gray-200' : 'border-gray-300 bg-white text-gray-900 hover:bg-gray-100'}`}
                disabled={disconnectLoading}
              >
                <span className="hidden sm:inline">{disconnectLoading ? "Disconnecting..." : "Log Out"}</span>
                <span className="sm:hidden">{disconnectLoading ? "..." : "Out"}</span>
                <svg className="h-3.5 w-3.5 sm:h-4 sm:w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </button>
              {disconnectError && <div className="hidden sm:block text-xs sm:text-sm text-red-400">{disconnectError.message}</div>}
            </div>
          </div>
        </div>
      </nav>

      {/* Main Dashboard Content - 2x2 Grid */}
      <div className="mx-auto max-w-7xl px-3 sm:px-4 md:px-6 py-4 sm:py-6 md:py-8">
        {/* TOP ROW */}
        <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-2 mb-4 sm:mb-6">
          {/* Left: Available Balance – refresh har 1 min + payment success pe */}
          <Balance refreshTrigger={balanceRefreshTrigger} isDarkTheme={isDarkTheme} />

          {/* Right: Top Up */}
          <div className={`rounded-[12px] sm:rounded-[18px] border p-4 sm:p-6 ${isDarkTheme ? 'border-white/10 bg-[#141923] shadow-[0_12px_30px_rgba(0,0,0,0.35)]' : 'border-gray-200 bg-white shadow-sm'}`}>
            <div className="mb-3 sm:mb-4 flex items-center gap-2">
              <svg className={`h-4 w-4 sm:h-5 sm:w-5 ${isDarkTheme ? 'text-gray-400' : 'text-gray-600'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <h2 className={`text-base sm:text-lg font-semibold ${isDarkTheme ? 'text-white' : 'text-gray-900'}`}>Add Funds</h2>
            </div>
            <div className="mb-4 sm:mb-6 flex justify-center">
              <div className="flex h-12 w-12 sm:h-16 sm:w-16 items-center justify-center rounded-xl sm:rounded-2xl bg-[#5B5DF0]">
                <svg className="h-6 w-6 sm:h-8 sm:w-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
              </div>
            </div>
            <p className={`mb-4 sm:mb-6 text-center text-xs sm:text-sm ${isDarkTheme ? 'text-gray-400' : 'text-gray-600'}`}>
              Add funds to your TopupGo account
            </p>
            <button
              onClick={handleTopUp}
              className={`w-full rounded-lg px-4 py-2.5 sm:py-3 text-xs sm:text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50 ${isDarkTheme ? 'border border-white/15 bg-white/10 hover:bg-white/15' : 'bg-gray-900 hover:bg-gray-800'}`}
              disabled={checkoutLoading || walletUiLoading}
            >
              {checkoutLoading || walletUiLoading ? "Opening Buy…" : "Top Up USD"}
            </button>
            {(checkoutError || walletUiError) && (
              <div className="mt-2 text-sm text-red-400">{(checkoutError || walletUiError)?.message}</div>
            )}
          </div>
        </div>

        {/* SECOND ROW */}
        <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-2">
          {/* Left: Send Payment */}
          <div className={`rounded-[12px] sm:rounded-[18px] border p-4 sm:p-6 ${isDarkTheme ? 'border-white/10 bg-[#141923] shadow-[0_12px_30px_rgba(0,0,0,0.35)]' : 'border-gray-200 bg-white shadow-sm'}`}>
            <SendTransaction onPaymentSuccess={handlePaymentSuccess} isDarkTheme={isDarkTheme} />
          </div>

          {/* Right: Profile */}
          <div className={`rounded-[12px] sm:rounded-[18px] border p-4 sm:p-6 ${isDarkTheme ? 'border-white/10 bg-[#141923] shadow-[0_12px_30px_rgba(0,0,0,0.35)]' : 'border-gray-200 bg-white shadow-sm'}`}>
            <div className="mb-3 sm:mb-4 flex items-center gap-2">
              <svg className={`h-4 w-4 sm:h-5 sm:w-5 ${isDarkTheme ? 'text-gray-400' : 'text-gray-600'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              <h2 className={`text-base sm:text-lg font-semibold ${isDarkTheme ? 'text-white' : 'text-gray-900'}`}>Profile</h2>
            </div>
            <div className="mb-3 sm:mb-4 flex justify-center">
              {userInfo?.profileImage ? (
                <img
                  src={userInfo.profileImage}
                  alt="Profile"
                  className={`h-16 w-16 sm:h-20 sm:w-20 rounded-full object-cover ring-2 ${isDarkTheme ? 'ring-[#5B5DF0]/60' : 'ring-gray-300'}`}
                />
              ) : (
                <div className={`flex h-16 w-16 sm:h-20 sm:w-20 items-center justify-center rounded-full ${isDarkTheme ? 'bg-[#0D1117]' : 'bg-gray-100'}`}>
                  <svg className={`h-8 w-8 sm:h-10 sm:w-10 ${isDarkTheme ? 'text-gray-500' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                </div>
              )}
            </div>
            <div className="mb-2 text-center">
              <p className={`text-sm sm:text-base font-semibold ${isDarkTheme ? 'text-white' : 'text-gray-900'}`}>
                {userInfo?.name || "User"}
              </p>
            </div>
            <div className="mb-3 sm:mb-4 text-center">
              <p className={`text-xs sm:text-sm ${isDarkTheme ? 'text-gray-400' : 'text-gray-600'}`}>
                {userInfo?.email || "user@example.com"}
              </p>
            </div>
            <div className={`mb-3 sm:mb-4 rounded-lg sm:rounded-xl border p-3 sm:p-4 ${isDarkTheme ? 'border-white/10 bg-[#0E1118]' : 'border-gray-200 bg-gray-50'}`}>
              <div className="space-y-2 sm:space-y-2.5 text-xs sm:text-sm">
                <div className="flex items-center justify-between">
                  <span className={isDarkTheme ? 'text-gray-400' : 'text-gray-500'}>Name</span>
                  <span className={`font-medium truncate ml-2 ${isDarkTheme ? 'text-gray-100' : 'text-gray-900'}`}>{userInfo?.name || "User"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className={isDarkTheme ? 'text-gray-400' : 'text-gray-500'}>Username</span>
                  <span className={`font-medium truncate ml-2 ${isDarkTheme ? 'text-gray-100' : 'text-gray-900'}`}>
                    {(userInfo as any)?.username ||
                      (userInfo as any)?.verifierId ||
                      (userInfo?.email ? userInfo.email.split("@")[0] : "user")}
                  </span>
                </div>
              </div>
            </div>
            {/* Wallet address copy */}
            {address && (
              <div className={`flex items-center justify-center gap-2 rounded-lg border px-2 sm:px-3 py-2 sm:py-2.5 ${isDarkTheme ? 'border-white/10 bg-[#0E1118]' : 'border-gray-200 bg-gray-50'}`}>
                <span className={`truncate text-[10px] sm:text-xs font-medium ${isDarkTheme ? 'text-gray-300' : 'text-gray-600'}`} title={address}>
                  {`${address.slice(0, 6)}...${address.slice(-4)}`}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(address);
                    toast.success('Address copied!');
                  }}
                  className={`flex-shrink-0 rounded p-1 sm:p-1.5 transition ${isDarkTheme ? 'text-gray-400 hover:bg-white/10 hover:text-white' : 'text-gray-500 hover:bg-gray-200 hover:text-gray-700'}`}
                  title="Copy address"
                >
                  <svg className="h-3.5 w-3.5 sm:h-4 sm:w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 sm:mt-6">
          <TransactionHistorySection
            refreshTrigger={balanceRefreshTrigger}
            userEmail={userInfo?.email || hookUserInfo?.email}
            isDarkTheme={isDarkTheme}
          />
        </div>
      </div>

      <div id="console" className="hidden">
        <p></p>
      </div>
    </div>
  );

  const marketingLineOne =
    "TopupGo is your ultimate destination for instant fiat wallet top-ups with the lowest market fees. We support all major wallets, ensuring your funds are added securely and instantly.";
  const marketingLineTwo =
    "Stop wasting money on high transaction costs — experience the most affordable and reliable service today.";

  const renderAnimatedWords = (text: string, startIndex: number) =>
    text.split(" ").map((word, index) => (
      <span
        key={`${word}-${index}`}
        className="word-fade inline-block"
        style={{ animationDelay: `${(startIndex + index) * 55}ms` }}
      >
        {word}&nbsp;
      </span>
    ));

  const unloggedInView = (
    <div className="min-h-screen text-slate-900">
      <div className="grid min-h-screen w-full lg:grid-cols-2">
        <div className="order-1 grid min-h-screen place-items-center bg-white px-6 pt-12 pb-16">
          <div className="w-full max-w-xl">
            <div className="mb-6 grid h-12 w-12 place-items-center rounded-full bg-slate-900 text-white shadow-[0_10px_24px_rgba(15,23,42,0.18)]">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h2 className="text-4xl font-semibold leading-tight text-slate-900 sm:text-5xl">
              Fastest Fiat
              <span className="block text-[#4f46e5]">Wallet Top-Ups</span>
            </h2>
            <p className="mt-4 text-base leading-relaxed text-slate-600 sm:text-lg">
              {renderAnimatedWords(marketingLineOne, 0)}
            </p>
            <p className="mt-4 text-base leading-relaxed text-slate-600 sm:text-lg">
              {renderAnimatedWords(marketingLineTwo, marketingLineOne.split(" ").length)}
            </p>

            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl bg-white p-4 shadow-sm">
                <div className="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-blue-50 text-blue-600">
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-slate-900">Instant Delivery</p>
                <p className="mt-1 text-xs text-slate-500">Funds reflected in seconds, not business days.</p>
              </div>
              <div className="rounded-2xl bg-white p-4 shadow-sm">
                <div className="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-blue-50 text-blue-600">
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 11c0-1.657 1.343-3 3-3s3 1.343 3 3v1h1a1 1 0 011 1v6a1 1 0 01-1 1H7a1 1 0 01-1-1v-6a1 1 0 011-1h1v-1c0-2.761 2.239-5 5-5" />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-slate-900">Secure System</p>
                <p className="mt-1 text-xs text-slate-500">Encrypted transactions with fraud protection.</p>
              </div>
              <div className="rounded-2xl bg-white p-4 shadow-sm">
                <div className="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-blue-50 text-blue-600">
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-slate-900">Lowest Fees</p>
                <p className="mt-1 text-xs text-slate-500">Keep more of your money with competitive rates.</p>
              </div>
            </div>
          </div>
        </div>

        <div className="order-2 grid min-h-screen place-items-center bg-slate-200 px-6 pt-12 pb-16">
          <div className="w-full max-w-md rounded-[28px] bg-white p-10 shadow-[0_28px_70px_rgba(15,23,42,0.16)]">
            <div className="mb-8 text-center">
              <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-slate-900 text-white shadow-[0_10px_24px_rgba(15,23,42,0.18)]">
                <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h2 className="text-2xl font-semibold text-slate-900">TopupGo</h2>
              <p className="mt-2 text-sm text-slate-600">Sign up to access your account dashboard</p>
            </div>

            <button
              onClick={() => connect()}
              disabled={connectLoading}
              className="w-full rounded-xl bg-slate-900 px-6 py-3.5 text-base font-semibold text-white transition-all hover:bg-slate-800 active:scale-[0.98] disabled:opacity-60"
            >
              {connectLoading ? "Connecting..." : "Sign Up Now →"}
            </button>

            <p className="mt-6 text-center text-sm text-slate-600">
              Need any help?{" "}
              <button className="font-medium text-slate-900 underline-offset-4 hover:underline" type="button">
                Contact Us
              </button>
            </p>

            <div className="mt-8 border-t border-slate-100 pt-4 text-center text-[11px] uppercase tracking-[0.2em] text-slate-400">
              Bank-grade security
            </div>

            {connectError && (
              <div className="mt-6 rounded-xl bg-red-50 px-4 py-3 text-center text-sm text-red-600">
                {connectError.message}
              </div>
            )}
          </div>
        </div>
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