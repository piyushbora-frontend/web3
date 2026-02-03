import { useWeb3Auth } from "@web3auth/modal/react";
import { BrowserProvider, Contract, formatEther, formatUnits } from "ethers";
import { useAccount, useChainId } from "wagmi";
import { useEffect, useState } from "react";

type TokenConfig = { symbol: string; address: string };

const USDC_BY_CHAIN: Record<number, string> = {
  137: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  11155111: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

export function Balance() {
  const { address } = useAccount();
  const chainId = useChainId();
  const { provider: web3AuthProvider } = useWeb3Auth();
  const [nativeBalance, setNativeBalance] = useState("0.00");
  const [usdcBalance, setUsdcBalance] = useState("0.00");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchBalances() {
      if (!web3AuthProvider || !address) return;
      setIsLoading(true);
      setError(null);
      try {
        const provider = new BrowserProvider(web3AuthProvider as any);
        const network = await provider.getNetwork();
        const activeChainId = chainId || Number(network.chainId);

        const native = await provider.getBalance(address);
        setNativeBalance(formatEther(native));

        const usdcAddress = USDC_BY_CHAIN[activeChainId];
        if (usdcAddress) {
          const erc20 = new Contract(usdcAddress, ERC20_ABI, provider);
          const raw = await erc20.balanceOf(address);
          const decimals = await erc20.decimals();
          setUsdcBalance(formatUnits(raw, decimals));
        } else {
          setUsdcBalance("0.00");
        }
      } catch (err: any) {
        setError(err?.message || "Failed to fetch balance.");
      } finally {
        setIsLoading(false);
      }
    }

    fetchBalances();
  }, [web3AuthProvider, address, chainId]);

  return (
    <div>
      <h2>Balance</h2>
      <div>Native: {nativeBalance} {isLoading && "Loading..."}</div>
      <div>USDC: {usdcBalance}</div>
      {error && <div>Error: {error}</div>}
    </div>
  )
}
