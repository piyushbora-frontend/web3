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
const AGENT_BY_ENS_API = "https://app.payairo.com/api/auth/r1/agent-by-ens/";
const ENS_CREDIT_API = "https://app.payairo.com/api/wallet/credit-balance-by-ens/";
const ENS_EMAIL_BY_NAME_API = "https://app.payairo.com/api/auth/email-by-ens-name/";
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

function getValueByPath(source: unknown, path: string[]): string | null {
  let cursor: unknown = source;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "string" && cursor.trim() ? cursor : null;
}

function extractWalletAddressFromResponse(payload: unknown): string | null {
  // Priority order keeps current "send payment API" behavior first.
  return (
    getValueByPath(payload, ["data", "wallet_address"]) ||
    getValueByPath(payload, ["wallet_address"]) ||
    getValueByPath(payload, ["data", "deposit_address"]) ||
    getValueByPath(payload, ["data", "wallet", "address"]) ||
    getValueByPath(payload, ["response", "data", "data", "wallet", "address"])
  );
}

type AddressStatus = "idle" | "loading" | "found" | "error";
type EnsEmailLookupResponse = {
  status?: boolean;
  message?: string;
  data?: {
    email?: string;
    ens_name?: string;
  };
};

export function SendTransaction({
  onPaymentSuccess,
  isDarkTheme = true,
  currentUserEmail,
  currentUserName,
}: {
  onPaymentSuccess?: () => void;
  isDarkTheme?: boolean;
  currentUserEmail?: string | null;
  currentUserName?: string | null;
}) {
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
  const lastResolvedWalletAddressRef = useRef<string | null>(null);

  async function fetchAgentWalletByEns(ensName: string): Promise<string | null> {
    const ens = ensName.trim();
    if (!ens) return null;

    try {
      const ensRes = await loggedFetch(`${AGENT_BY_ENS_API}?sol=${encodeURIComponent(ens)}`, {
        headers: { Accept: "application/json" },
        logLabel: "PayAiro agent-by-ens",
      });
      if (!ensRes.ok) {
        const ensErrText = await ensRes.text().catch(() => "");
        console.error("[SendTransaction] ENS fallback API failed", {
          status: ensRes.status,
          ensErrText,
        });
        return null;
      }

      const ensJson = await ensRes.json().catch(() => null);
      const ensWalletAddress = getValueByPath(ensJson, ["response", "data", "data", "wallet", "address"]) ||
        getValueByPath(ensJson, ["data", "data", "wallet", "address"]);
      if (ensWalletAddress) {
        console.log("[SendTransaction] ENS fallback resolved wallet address", { ensName: ens, ensWalletAddress });
      } else {
        console.warn("[SendTransaction] ENS fallback response missing wallet address", ensJson);
      }
      return ensWalletAddress;
    } catch (ensErr) {
      console.error("[SendTransaction] ENS fallback exception", ensErr);
      return null;
    }
  }

  async function resolveWalletAddress(username: string): Promise<string | null> {
    const normalizedUsername = username.trim();
    if (!normalizedUsername) return null;

    console.log("[SendTransaction] resolveWalletAddress started", { username: normalizedUsername });

    // Step 1: Check current Send Payment API response first.
    try {
      const primaryRes = await loggedFetch(
        `${DEPOSIT_ADDRESS_API}/?username=${encodeURIComponent(normalizedUsername)}`,
        { headers: { Accept: "application/json" }, logLabel: "PayAiro deposit address (resolve)" }
      );
      const primaryJson = await primaryRes.json().catch(() => null);
      const primaryWalletAddress = extractWalletAddressFromResponse(primaryJson);
      if (primaryWalletAddress) {
        console.log("[SendTransaction] resolved wallet from primary API response", { primaryWalletAddress });
        lastResolvedWalletAddressRef.current = primaryWalletAddress;
        return primaryWalletAddress;
      }
      console.warn("[SendTransaction] primary API returned without wallet address", primaryJson);
    } catch (primaryErr) {
      console.error("[SendTransaction] primary wallet resolve API failed", primaryErr);
    }

    // Step 2: Use any wallet address already available in current flow.
    const existingAddress = fetchedAddress || lastResolvedWalletAddressRef.current;
    if (existingAddress) {
      console.log("[SendTransaction] using cached wallet address from current flow", { existingAddress });
      return existingAddress;
    }

    // Step 3: ENS fallback API.
    const ensWalletAddress = await fetchAgentWalletByEns(normalizedUsername);
    if (ensWalletAddress) {
      lastResolvedWalletAddressRef.current = ensWalletAddress;
      return ensWalletAddress;
    }

    console.warn("[SendTransaction] wallet address not found after all fallbacks", { username: normalizedUsername });
    return null;
  }

  async function getAccessTokenForCurrentUser(): Promise<string | null> {
    const email = (currentUserEmail || userInfo?.email || "").trim();
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
    receiverName: string;
    receiverEmail?: string;
  }): Promise<boolean> {
    if (transactionSyncInFlight.current) {
      console.log("[TopupGo Txn] SKIPPED: transaction sync already in progress");
      return false;
    }

    transactionSyncInFlight.current = true;
    try {
      const accessToken = await getAccessTokenForCurrentUser();
      if (!accessToken) return false;

      const amountNumber = Number(params.amount || 0);
      const safeAmount = Number.isFinite(amountNumber) ? amountNumber : 0;
      const senderName = currentUserName || userInfo?.name || "Unknown User";
      const senderEmail = (currentUserEmail || userInfo?.email || "").trim();
      const receiverEmail = (params.receiverEmail || "").trim();
      const transactionPayload: Record<string, unknown> = {
        transaction_id: params.txHash,
        amount: safeAmount,
        fee: 0,
        final_amount: safeAmount,
        transaction_type: "debit",
        status: "completed",
        description: `Payment sent to ${params.receiverName}`,
        wallet_address: params.walletAddress,
        sender_name: senderName,
        receiver_name: params.receiverName,
        sender_email: senderEmail,
        sender_type: "send",
        metadata: {
          order_id: params.txHash,
          payment_gateway: "web3auth",
          token: TOKEN_CONFIG.symbol,
          sender_wallet: params.walletAddress,
          receiver_wallet: params.recipientAddress,
        },
      };
      if (receiverEmail) {
        transactionPayload.receiver_email = receiverEmail;
      }

      console.log("[TopupGo Txn] REQUEST payload prepared", {
        txHash: params.txHash,
        receiverName: params.receiverName,
        hasReceiverEmail: Boolean(receiverEmail),
      });

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
        console.error("[TopupGo Txn] FAILED", { status: txRes.status, txErrText, txHash: params.txHash });
        return false;
      }

      const txJson = await txRes.json().catch(() => null);
      console.log("[TopupGo Txn] SUCCESS", txJson);

      const createdTransactionId = txJson?.id ?? txJson?.data?.id;
      if (createdTransactionId !== undefined && createdTransactionId !== null) {
        await getTransactionById(createdTransactionId, accessToken);
      } else {
        console.warn("[TopupGo Txn] transaction id missing in create response, skipping detail GET");
      }

      return true;
    } catch (syncErr) {
      console.error("[TopupGo Txn] ERROR", syncErr);
      return false;
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
      const resolvedAddress = await resolveWalletAddress(u);
      if (!resolvedAddress) {
        setFetchedAddress(null);
        setAddressStatus("error");
        setShowUserNotFoundModal(true);
        return;
      }
      setFetchedAddress(resolvedAddress);
      setAddressStatus("found");
    } catch {
      setFetchedAddress(null);
      setAddressStatus("error");
      setShowUserNotFoundModal(true);
    }
  }

  async function creditByEnsIfRequired(receiverIdentifier: string, amount: string): Promise<void> {
    const ensName = receiverIdentifier.trim();
    if (!ensName.toLowerCase().endsWith(".sol")) {
      console.log("[ENS Credit] skipped: receiver is not .sol", { receiverIdentifier: ensName });
      return;
    }

    console.log("[ENS Credit] initiating", { ensName, amount });

    try {
      const creditRes = await loggedFetch(ENS_CREDIT_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          ens_name: ensName,
          amount,
        }),
        logLabel: "PayAiro ENS credit",
      });

      const creditJson = await creditRes.json().catch(() => null);

      if (!creditRes.ok || !creditJson?.status || creditJson?.data?.status === false) {
        const apiMessage =
          creditJson?.data?.message ||
          creditJson?.message ||
          "ENS credit API failed";
        console.error("[ENS Credit] failed", {
          status: creditRes.status,
          creditJson,
        });
        throw new Error(apiMessage);
      }

      console.log("[ENS Credit] success", creditJson);
    } catch (ensErr) {
      console.error("[ENS Credit] exception", ensErr);
      throw new Error("ENS credit failed. Payment aborted.");
    }
  }

  async function resolveReceiverEmailForTransaction(receiverIdentifier: string): Promise<string | undefined> {
    const normalizedReceiver = receiverIdentifier.trim();
    if (!normalizedReceiver.toLowerCase().endsWith(".sol")) {
      return undefined;
    }

    try {
      const res = await loggedFetch(
        `${ENS_EMAIL_BY_NAME_API}?ens_name=${encodeURIComponent(normalizedReceiver)}`,
        {
          headers: { accept: "application/json" },
          logLabel: "PayAiro email-by-ens-name",
        }
      );

      const json = (await res.json().catch(() => null)) as EnsEmailLookupResponse | null;
      const resolvedEmail = String(json?.data?.email || "").trim();
      if (!res.ok || !json?.status || !resolvedEmail) {
        throw new Error("Could not resolve receiver email for ENS name.");
      }

      return resolvedEmail;
    } catch (err) {
      throw new Error("Could not resolve receiver email for ENS name.");
    }
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!web3AuthProvider || !address) {
      setError(new Error("Not connected"));
      toast.error("Not connected");
      return;
    }

    const formElement = e.currentTarget;
    const formData = new FormData(formElement);
    const username = (formData.get("username") as string)?.trim();
    const amountStr = formData.get("value") as string;
    console.log("[SendTransaction] submit", { username, amountStr, from: address });

    if (!username) {
      toast.error("Please enter a PayAiro tag.");
      return;
    }

    if (!amountStr || Number(amountStr) <= 0) {
      toast.error("Please enter a valid amount.");
      return;
    }

    // Validate/resolve address with robust fallback on Send click.
    let recipientAddress = fetchedAddress;
    if (addressStatus !== "found" || !recipientAddress) {
      setIsPending(true);
      setError(null);
      toast.loading("Checking PayAiro tag…", { id: "payment" });
      try {
        recipientAddress = await resolveWalletAddress(username);
        if (!recipientAddress) {
          throw new Error("Wallet address not found for this user");
        }
        setFetchedAddress(recipientAddress);
        setAddressStatus("found");
        toast.loading("Sending payment…", { id: "payment" });
      } catch (err: any) {
        toast.dismiss("payment");
        setAddressStatus("error");
        toast.error("Wallet address not found for this user", { id: "payment" });
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
      const receiverEmail = await resolveReceiverEmailForTransaction(username);
      const normalizedRecipient = normalizeAddress(recipientAddress);
      const amountInUnits = parseUnits(amountStr, TOKEN_CONFIG.decimals);
      console.log("[SendTransaction] resolved recipient", {
        username,
        recipientAddress,
        normalizedRecipient,
        amountInUnits: amountInUnits.toString(),
      });

      // ENS credit is executed only during payment processing.
      await creditByEnsIfRequired(username, amountStr);

      const provider = new BrowserProvider(web3AuthProvider as any);
      const signer = await provider.getSigner();
      console.log("[SendTransaction] recipient validated for transfer", {
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
      const syncedToBackend = await syncTransactionToBackend({
        txHash: tx.hash,
        amount: amountStr,
        walletAddress: address,
        recipientAddress: normalizedRecipient,
        receiverName: username,
        receiverEmail,
      });

      if (!syncedToBackend) {
        toast.error("Payment sent, but transaction history sync failed. Please refresh shortly.", { id: "payment" });
      } else {
        // Refresh dashboard widgets instantly after successful backend sync.
        onPaymentSuccess?.();
        toast.success("Payment successful!", { id: "payment" });
      }

      // Reset form fields after successful on-chain payment.
      formElement.reset();
      setAddressStatus("idle");
      setFetchedAddress(null);
      setError(null);
    } catch (err: any) {
      setError(err);
      const msg = err?.message || "";
      if (msg.toLowerCase().includes("ens credit")) {
        toast.error(msg || "ENS credit failed. Payment aborted.", { id: "payment" });
      } else if (msg.toLowerCase().includes("could not resolve receiver email")) {
        toast.error("Could not resolve receiver email for the provided .sol name.", { id: "payment" });
      } else if (msg.includes("429") || msg.includes("Too Many Requests")) {
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
    }
  }, [isConfirmed]);

  return (
    <div>
      <div className="mb-4 sm:mb-6 flex items-center gap-2">
        <svg className={`h-4 w-4 sm:h-5 sm:w-5 ${isDarkTheme ? 'text-pink-400' : 'text-gray-600'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
        </svg>
        <h2 className={`text-base sm:text-lg font-semibold ${isDarkTheme ? 'text-white' : 'text-gray-900'}`}>Send Payment</h2>
      </div>
      
      <form onSubmit={submit} className="space-y-4 sm:space-y-6">
        <div>
          <label className={`mb-1.5 sm:mb-2 block text-[10px] sm:text-xs font-semibold uppercase tracking-wide ${isDarkTheme ? 'text-gray-400' : 'text-gray-600'}`}>
            Recipient ID
          </label>
          <div className="flex items-center gap-2">
            <input
              name="username"
              placeholder="Enter Pay tag"
              required
              onBlur={(e) => lookupUsername((e.target as HTMLInputElement).value)}
              onChange={() => { setAddressStatus("idle"); setFetchedAddress(null); }}
              className={`w-full rounded-lg border px-3 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm transition-all ${isDarkTheme ? 'border-white/10 bg-[#0E1118] text-white placeholder-gray-500 focus:border-[#5B5DF0] focus:outline-none' : 'border-gray-200 bg-white text-gray-900 placeholder-gray-400 focus:border-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-200'}`}
            />
            {addressStatus === "loading" && (
              <span className="flex h-5 w-5 sm:h-6 sm:w-6 flex-shrink-0 items-center justify-center text-gray-500">
                <svg className="h-3.5 w-3.5 sm:h-4 sm:w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              </span>
            )}
            {addressStatus === "found" && (
              <span className="flex h-5 w-5 sm:h-6 sm:w-6 flex-shrink-0 items-center justify-center rounded-full bg-green-100 text-green-600" title="Address found">
                <svg className="h-3.5 w-3.5 sm:h-4 sm:w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </span>
            )}
            {addressStatus === "error" && (
              <span className="flex h-5 w-5 sm:h-6 sm:w-6 flex-shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600" title="Wrong address">
                <svg className="h-3.5 w-3.5 sm:h-4 sm:w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </span>
            )}
          </div>
          {/* <p className="mt-1 text-[10px] sm:text-xs text-gray-500">Enter PayAiro tag for sending money to a PayAiro user.</p> */}
        </div>

        <div>
          <label className={`mb-1.5 sm:mb-2 block text-[10px] sm:text-xs font-semibold uppercase tracking-wide ${isDarkTheme ? 'text-gray-400' : 'text-gray-600'}`}>
            Amount (USD)
          </label>
          <input
            name="value"
            placeholder="Enter amount in USD"
            type="number"
            step="0.01"
            required
            className={`w-full rounded-lg border px-3 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm transition-all ${isDarkTheme ? 'border-white/10 bg-[#0E1118] text-white placeholder-gray-500 focus:border-[#5B5DF0] focus:outline-none' : 'border-gray-200 bg-white text-gray-900 placeholder-gray-400 focus:border-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-200'}`}
          />
        </div>
        
        <button
          disabled={isPending || isConfirming}
          type="submit"
          className={`w-full rounded-lg px-4 sm:px-6 py-2.5 sm:py-3 text-xs sm:text-sm font-semibold transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 ${isDarkTheme ? 'bg-white text-gray-900 hover:bg-gray-200' : 'bg-gray-900 text-white hover:bg-gray-800'}`}
        >
          {isPending ? 'Processing...' : isConfirming ? 'Confirming payment...' : 'Send Now'}
        </button>
      </form>

      {error && (
        <div className={`mt-3 sm:mt-4 rounded-lg border p-2.5 sm:p-3 text-xs sm:text-sm ${isDarkTheme ? 'border-red-500/30 bg-red-500/10 text-red-300' : 'border-red-200 bg-red-50 text-red-600'}`}>
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
