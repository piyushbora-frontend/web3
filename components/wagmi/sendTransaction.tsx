import { FormEvent, useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useWaitForTransactionReceipt, BaseError } from "wagmi";
import { useWeb3Auth, useWeb3AuthUser } from "@web3auth/modal/react";
import { BrowserProvider, Contract, parseUnits, formatUnits } from "ethers";
import { useAccount } from "wagmi";
import { USDC_POLYGON, USDC_POLYGON_NATIVE, ERC20_ABI, normalizeAddress, TOKEN_CONFIG } from "./config";
import toast from "react-hot-toast";
import { loggedFetch } from "../../lib/loggedFetch";

const DEPOSIT_ADDRESS_API = "https://app.payairo.com/api/auth/r1/deposit-address";
const TOPUPGO_TRANSACTIONS_API = "https://api.topupgo.org/api/transactions/";
const TOPUPGO_ACCOUNTS_EXISTS_API = "https://api.topupgo.org/api/account/exists/";
const TOPUPGO_WALLETS_API = "https://api.topupgo.org/api/wallets/";
const TOPUPGO_CSRF_TOKEN = process.env.NEXT_PUBLIC_TOPUPGO_CSRF_TOKEN;

const USDC_CONTRACTS = [
  { address: USDC_POLYGON_NATIVE, label: "USDC" },
  { address: USDC_POLYGON, label: "USDC.e" },
] as const;

async function fetchDepositAddress(username: string): Promise<string> {
  const res = await loggedFetch(
    `${DEPOSIT_ADDRESS_API}/?username=${encodeURIComponent(username.trim())}`,
    { headers: { Accept: "application/json" }, logLabel: "PayAiro deposit address" }
  );
  const json = await res.json();
  if (json?.status && json?.data?.deposit_address) return json.data.deposit_address;
  throw new Error(json?.message || "Could not find deposit address for this username.");
}

type AddressStatus = "idle" | "loading" | "found" | "error";

export function SendTransaction({ onPaymentSuccess }: { onPaymentSuccess?: () => void }) {
  const { provider: web3AuthProvider } = useWeb3Auth();
  const { userInfo } = useWeb3AuthUser();
  const { address } = useAccount();
  const [hash, setHash] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [addressStatus, setAddressStatus] = useState<AddressStatus>("idle");
  const [fetchedAddress, setFetchedAddress] = useState<string | null>(null);
  const [showUserNotFoundModal, setShowUserNotFoundModal] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const transactionSyncInFlight = useRef(false);

  async function getAccessTokenForCurrentUser(): Promise<string | null> {
    const email = userInfo?.email;
    if (!email) {
      console.error("[TopupGo Txn] access token fetch skipped: user email not available");
      return null;
    }

    const existsRes = await loggedFetch(`${TOPUPGO_ACCOUNTS_EXISTS_API}?email=${encodeURIComponent(email)}`, {
      headers: {
        accept: "application/json",
        ...(TOPUPGO_CSRF_TOKEN ? { "X-CSRFTOKEN": TOPUPGO_CSRF_TOKEN } : {}),
      },
      logLabel: "TopupGo account exists (transaction)",
    });

    const existsJson = await existsRes.json().catch(() => null);
    const accessToken = existsJson?.access_token ?? null;
    if (!accessToken) {
      console.error("[TopupGo Txn] access token missing in account exists response", existsJson);
    }
    return accessToken;
  }

  async function getWalletIdByAddress(accessToken: string, walletAddress: string): Promise<number | null> {
    const listRes = await loggedFetch(TOPUPGO_WALLETS_API, {
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...(TOPUPGO_CSRF_TOKEN ? { "X-CSRFTOKEN": TOPUPGO_CSRF_TOKEN } : {}),
      },
      logLabel: "TopupGo wallets list (transaction)",
    });

    if (!listRes.ok) {
      const listErr = await listRes.text().catch(() => "");
      console.error("[TopupGo Txn] failed to list wallets", { status: listRes.status, listErr });
      return null;
    }

    const listJson = await listRes.json().catch(() => null);
    const wallets = Array.isArray(listJson)
      ? listJson
      : Array.isArray(listJson?.results)
        ? listJson.results
        : Array.isArray(listJson?.data)
          ? listJson.data
          : [];
    const normalized = walletAddress.toLowerCase();
    const matchedWallet = wallets.find((w: any) => String(w?.address || "").toLowerCase() === normalized);
    const walletId = matchedWallet?.id ?? null;
    if (!walletId) {
      console.error("[TopupGo Txn] wallet id not found for address", { walletAddress, walletsCount: wallets.length });
    }
    return walletId;
  }

  async function getTransactionById(transactionId: number | string, accessToken: string) {
    const detailUrl = `${TOPUPGO_TRANSACTIONS_API}${transactionId}/`;
    const detailRes = await loggedFetch(detailUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...(TOPUPGO_CSRF_TOKEN ? { "X-CSRFTOKEN": TOPUPGO_CSRF_TOKEN } : {}),
      },
      logLabel: "TopupGo transaction detail",
    });

    if (!detailRes.ok) {
      const detailErr = await detailRes.text().catch(() => "");
      console.error("[TopupGo Txn] GET detail failed", {
        status: detailRes.status,
        detailUrl,
        detailErr,
      });
      return null;
    }

    const detailJson = await detailRes.json().catch(() => null);
    console.log("[TopupGo Txn] GET detail success", detailJson);
    return detailJson;
  }

  async function syncTransactionToBackend(params: {
    txHash: string;
    amount: string;
    walletAddress: string;
    recipientAddress: string;
  }) {
    if (transactionSyncInFlight.current) {
      console.log("[TopupGo Txn] SKIPPED: transaction sync already in progress");
      return;
    }

    transactionSyncInFlight.current = true;
    try {
      const accessToken = await getAccessTokenForCurrentUser();
      if (!accessToken) return;

      const walletId = await getWalletIdByAddress(accessToken, params.walletAddress);
      if (!walletId) {
        console.error("[TopupGo Txn] SKIPPED: wallet id unavailable, transactions API requires wallet");
        return;
      }

      const amountNumber = Number(params.amount || 0);
      const transactionPayload = {
        transaction_id: params.txHash,
        wallet: walletId,
        amount: Number.isFinite(amountNumber) ? amountNumber : 0,
        fee: 0,
        final_amount: Number.isFinite(amountNumber) ? amountNumber : 0,
        transaction_type: "send",
        status: "pending",
        description: `USDC transfer to ${params.recipientAddress}`,
        metadata: {
          tx_hash: params.txHash,
          token: TOKEN_CONFIG.symbol,
          sender: params.walletAddress,
          recipient: params.recipientAddress,
        },
      };

      console.log("[TopupGo Txn] REQUEST payload", transactionPayload);

      const txRes = await loggedFetch(TOPUPGO_TRANSACTIONS_API, {
        method: "POST",
        headers: {
          accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...(TOPUPGO_CSRF_TOKEN ? { "X-CSRFTOKEN": TOPUPGO_CSRF_TOKEN } : {}),
        },
        body: JSON.stringify(transactionPayload),
        logLabel: "TopupGo transaction create",
      });

      if (!txRes.ok) {
        const txErrText = await txRes.text().catch(() => "");
        console.error("[TopupGo Txn] FAILED", { status: txRes.status, txErrText, transactionPayload });
        return;
      }

      const txJson = await txRes.json().catch(() => null);
      console.log("[TopupGo Txn] SUCCESS", txJson);

      const createdTransactionId = txJson?.id ?? txJson?.data?.id;
      if (createdTransactionId !== undefined && createdTransactionId !== null) {
        await getTransactionById(createdTransactionId, accessToken);
      } else {
        console.warn("[TopupGo Txn] transaction id missing in create response, skipping detail GET");
      }
    } catch (syncErr) {
      console.error("[TopupGo Txn] ERROR", syncErr);
    } finally {
      transactionSyncInFlight.current = false;
    }
  }

  async function lookupUsername(username: string) {
    const u = username.trim();
    if (!u) {
      setAddressStatus("idle");
      setFetchedAddress(null);
      return;
    }
    setAddressStatus("loading");
    setFetchedAddress(null);
    try {
      const addr = await fetchDepositAddress(u);
      setFetchedAddress(addr);
      setAddressStatus("found");
    } catch {
      setFetchedAddress(null);
      setAddressStatus("error");
      setShowUserNotFoundModal(true);
    }
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!web3AuthProvider || !address) {
      setError(new Error("Not connected"));
      toast.error("Not connected");
      return;
    }

    const formData = new FormData(e.target as HTMLFormElement);
    const username = (formData.get("username") as string)?.trim();
    const amountStr = formData.get("value") as string;
    console.log("[SendTransaction] submit", { username, amountStr, from: address });

    if (!username) {
      toast.error("Please enter a PayAiro tag.");
      return;
    }

    // Validate address via API first – Send pe click pe hi error agar galat ho
    let recipientAddress = fetchedAddress;
    if (addressStatus !== "found" || !recipientAddress) {
      setIsPending(true);
      setError(null);
      toast.loading("Checking PayAiro tag…", { id: "payment" });
      try {
        recipientAddress = await fetchDepositAddress(username);
        setFetchedAddress(recipientAddress);
        setAddressStatus("found");
        toast.loading("Sending payment…", { id: "payment" });
      } catch (err: any) {
        toast.dismiss("payment");
        setAddressStatus("error");
        setShowUserNotFoundModal(true);
        setIsPending(false);
        return;
      }
    }

    setIsPending(true);
    setError(null);
    setHash(null);
    toast.loading("Sending payment…", { id: "payment" });

    try {
      const normalizedRecipient = normalizeAddress(recipientAddress);
      const provider = new BrowserProvider(web3AuthProvider as any);
      const signer = await provider.getSigner();
      const amountInUnits = parseUnits(amountStr, TOKEN_CONFIG.decimals);
      console.log("[SendTransaction] resolved recipient", {
        username,
        recipientAddress,
        normalizedRecipient,
        amountInUnits: amountInUnits.toString(),
      });

      // Check balance on both USDC contracts; use the one that has enough
      let chosenContractAddress: string | null = null;
      let totalAvailable = BigInt(0);
      for (const { address: contractAddress } of USDC_CONTRACTS) {
        const contract = new Contract(normalizeAddress(contractAddress), ERC20_ABI, provider);
        const balance = await contract.balanceOf(address);
        totalAvailable += balance;
        if (balance >= amountInUnits && chosenContractAddress === null) {
          chosenContractAddress = contractAddress;
        }
      }
      if (chosenContractAddress === null) {
        const totalFormatted = formatUnits(totalAvailable, TOKEN_CONFIG.decimals);
        const msg = totalAvailable === BigInt(0)
          ? "Insufficient USDC balance. You have $0.00."
          : `Insufficient USDC balance. You have $${parseFloat(totalFormatted).toFixed(2)} available.`;
        setError(new Error(msg));
        toast.error(msg, { id: "payment" });
        setIsPending(false);
        return;
      }

      const usdcContract = new Contract(normalizeAddress(chosenContractAddress), ERC20_ABI, signer);
      console.log("[SendTransaction] using contract", { chosenContractAddress });
      const tx = await usdcContract.transfer(normalizedRecipient, amountInUnits);
      console.log("[SendTransaction] tx sent", { hash: tx.hash });
      setHash(tx.hash);
      await tx.wait();
      console.log("[SendTransaction] tx confirmed", { hash: tx.hash });

      // Sync transaction record to backend exactly once per successful on-chain transfer.
      await syncTransactionToBackend({
        txHash: tx.hash,
        amount: amountStr,
        walletAddress: address,
        recipientAddress: normalizedRecipient,
      });

      toast.success("Payment successful!", { id: "payment" });
    } catch (err: any) {
      setError(err);
      const msg = err?.message || "";
      if (msg.includes("429") || msg.includes("Too Many Requests")) {
        toast.error("Too many requests. Please wait a moment and try again.", { id: "payment" });
      } else if (msg.includes("transfer amount exceeds balance")) {
        toast.error("Insufficient USDC balance. Check your available balance.", { id: "payment" });
      } else {
        toast.error("Payment failed", { id: "payment" });
      }
    } finally {
      setIsPending(false);
    }
  }

  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({
      hash: hash as `0x${string}` | undefined,
    });

  useEffect(() => {
    if (isConfirmed) {
      setShowSuccessModal(true);
      onPaymentSuccess?.();
    }
  }, [isConfirmed, onPaymentSuccess]);

  return (
    <div>
      <div className="mb-6 flex items-center gap-2">
        <svg className="h-5 w-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
        </svg>
        <h2 className="text-lg font-semibold text-gray-900">Send Payment</h2>
      </div>
      
      <form onSubmit={submit} className="space-y-6">
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-900">
            PayAiro tag
          </label>
          <div className="flex items-center gap-2">
            <input
              name="username"
              placeholder="Enter PayAiro tag"
              required
              onBlur={(e) => lookupUsername((e.target as HTMLInputElement).value)}
              onChange={() => { setAddressStatus("idle"); setFetchedAddress(null); }}
              className="w-full rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:border-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-200 transition-all"
            />
            {addressStatus === "loading" && (
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center text-gray-400">
                <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              </span>
            )}
            {addressStatus === "found" && (
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-green-100 text-green-600" title="Address found">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </span>
            )}
            {addressStatus === "error" && (
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600" title="Wrong address">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-gray-500">Enter PayAiro tag for sending money to a PayAiro user.</p>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-gray-900">
            Amount (USD)
          </label>
          <input
            name="value"
            placeholder="Enter amount in USD"
            type="number"
            step="0.01"
            required
            className="w-full rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:border-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-200 transition-all"
          />
        </div>
        
        <button
          disabled={isPending || isConfirming}
          type="submit"
          className="w-full rounded-lg px-6 py-3 text-sm font-medium text-white transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ backgroundColor: '#111827' }}
        >
          {isPending ? 'Processing...' : isConfirming ? 'Confirming payment...' : 'Send Payment'}
        </button>
      </form>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
          Error: {(error as BaseError).shortMessage || error.message}
        </div>
      )}

      {/* Center modal: Payment successful – portal se render taaki OK click sahi se kaam kare */}
      {showSuccessModal &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
            onClick={() => setShowSuccessModal(false)}
            role="dialog"
            aria-modal="true"
          >
            <div
              className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex justify-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
                  <svg className="h-6 w-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </span>
              </div>
              <p className="mt-4 text-center text-base font-medium text-gray-900">
                Payment successful!
              </p>
              <p className="mt-1 text-center text-sm text-gray-500">
                Your payment has been sent successfully.
              </p>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setShowSuccessModal(false);
                }}
                className="mt-6 w-full rounded-xl bg-gray-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-gray-800"
              >
                OK
              </button>
            </div>
          </div>,
          document.body
        )}

      {/* Center modal: This PayAiro user not found */}
      {showUserNotFoundModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setShowUserNotFoundModal(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
                <svg className="h-6 w-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </span>
            </div>
            <p className="mt-4 text-center text-base font-medium text-gray-900">
              This PayAiro user not found
            </p>
            <p className="mt-1 text-center text-sm text-gray-500">
              Please check the PayAiro tag and try again.
            </p>
            <button
              type="button"
              onClick={() => setShowUserNotFoundModal(false)}
              className="mt-6 w-full rounded-xl bg-gray-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-gray-800"
            >
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
