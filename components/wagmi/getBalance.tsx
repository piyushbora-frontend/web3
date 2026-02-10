import { useWeb3Auth } from "@web3auth/modal/react";
import { BrowserProvider, Contract, formatUnits } from "ethers";
import { useAccount, useChainId } from "wagmi";
import { useEffect, useState } from "react";
import { USDC_POLYGON, USDC_POLYGON_NATIVE, ERC20_ABI, normalizeAddress, POLYGON_CHAIN_ID } from "./config";

const REFRESH_INTERVAL_MS = 60 * 1000; // 1 min

export function Balance({ refreshTrigger, isDarkTheme = true }: { refreshTrigger?: number; isDarkTheme?: boolean }) {
  const { address } = useAccount();
  const chainId = useChainId();
  const { provider: web3AuthProvider } = useWeb3Auth();
  const [usdBalance, setUsdBalance] = useState("0.00");
  const [isLoading, setIsLoading] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Har 1 min pe balance refresh
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchBalance(retryCount = 0) {
      if (!web3AuthProvider || !address) return;
      // Sirf pehli baar ya jab abhi tak balance nahi aaya – Loading dikhao. Refetch pe purana balance dikhte raho.
      if (!hasLoadedOnce) setIsLoading(true);
      setError(null);
      try {
        const provider = new BrowserProvider(web3AuthProvider as any);
        const activeChainId = chainId ?? Number((await provider.getNetwork()).chainId);

        if (activeChainId === POLYGON_CHAIN_ID) {
          let total = BigInt(0);
          const decimals = 6; // USDC has 6 decimals
          for (const usdcAddress of [USDC_POLYGON, USDC_POLYGON_NATIVE]) {
            const contract = new Contract(normalizeAddress(usdcAddress), ERC20_ABI, provider);
            const raw = await contract.balanceOf(address);
            total += raw;
          }
          if (!cancelled) {
            setUsdBalance(formatUnits(total, decimals));
            setHasLoadedOnce(true);
          }
        } else {
          if (!cancelled) {
            setUsdBalance("0.00");
            setHasLoadedOnce(true);
          }
        }
      } catch (err: any) {
        const msg = err?.message || "";
        const isRpcError = msg.includes("missing revert data") || msg.includes("CALL_EXCEPTION") || msg.includes("429") || msg.includes("Too Many");
        if (isRpcError && retryCount < 1) {
          await new Promise((r) => setTimeout(r, 1500));
          if (!cancelled) return fetchBalance(retryCount + 1);
        }
        if (!cancelled) {
          setUsdBalance("0.00");
          setHasLoadedOnce(true);
          setError(isRpcError ? "Balance unavailable. Try again in a moment." : (msg || "Failed to fetch balance."));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchBalance();
    return () => { cancelled = true; };
  }, [web3AuthProvider, address, chainId, tick, refreshTrigger]); // hasLoadedOnce intentionally not in deps

  // USD value (1:1 for USDC)
  const usdBalanceValue = parseFloat(usdBalance).toFixed(2);

  return (
    <div className={`rounded-[12px] sm:rounded-[18px] border p-4 sm:p-6 ${isDarkTheme ? 'border-white/10 bg-[#141923] shadow-[0_12px_30px_rgba(0,0,0,0.35)]' : 'border-gray-200 bg-white shadow-sm'}`}>
      <h2 className={`mb-3 sm:mb-4 text-base sm:text-lg font-semibold ${isDarkTheme ? 'text-white' : 'text-gray-900'}`}>Available Balance</h2>
      
      {/* Loading sirf jab abhi tak balance load nahi hua; refetch pe purana balance dikhao, 0 mat dikhao */}
      {isLoading && !hasLoadedOnce && (
        <div className={`py-6 sm:py-8 text-center text-xs sm:text-sm ${isDarkTheme ? 'text-gray-400' : 'text-gray-600'}`}>Loading...</div>
      )}

      {error && (
        <div className={`mb-3 sm:mb-4 rounded-lg border p-2.5 sm:p-3 text-xs sm:text-sm ${isDarkTheme ? 'border-red-500/30 bg-red-500/10 text-red-300' : 'border-red-200 bg-red-50 text-red-600'}`}>
          Error: {error}
        </div>
      )}

      {(hasLoadedOnce || !isLoading) && !error && (
        <div>
          <p className={`mb-1.5 sm:mb-2 text-3xl sm:text-4xl font-bold ${isDarkTheme ? 'text-white' : 'text-gray-900'}`}>${usdBalanceValue}</p>
          <p className={`text-sm sm:text-base font-medium ${isDarkTheme ? 'text-gray-400' : 'text-gray-600'}`}>USD</p>
        </div>
      )}
    </div>
  )
}
