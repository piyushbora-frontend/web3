"use client";

import { useEffect, useMemo, useState } from "react";
import { loggedFetch } from "../../lib/loggedFetch";

type PaymentType = "Send" | "Receive" | "Topup";
type StatusType = "completed" | "pending" | "failed";

type Transaction = {
  id: string;
  username: string;
  amount: number;
  type: PaymentType;
  status: StatusType;
};

type ApiTransaction = {
  id: number;
  amount?: string | number;
  transaction_type?: string;
  status?: string;
  receiver_name?: string;
  sender_name?: string;
  description?: string;
};

const PAGE_SIZE = 10;
const TOPUPGO_ACCOUNT_EXISTS_API = "https://api.topupgo.org/api/account/exists/";
const TOPUPGO_TRANSACTIONS_API = "https://api.topupgo.org/api/transactions/";
const TOPUPGO_CSRF_TOKEN = process.env.NEXT_PUBLIC_TOPUPGO_CSRF_TOKEN;

function mapPaymentType(transactionType: string | undefined): PaymentType {
  const value = String(transactionType || "").toLowerCase();
  if (value === "debit" || value === "send") return "Send";
  if (value === "credit" || value === "receive") return "Receive";
  return "Topup";
}

function mapStatus(status: string | undefined): StatusType {
  const value = String(status || "").toLowerCase();
  if (value === "completed") return "completed";
  if (value === "pending") return "pending";
  return "failed";
}

function mapTransaction(item: ApiTransaction): Transaction {
  const type = mapPaymentType(item.transaction_type);
  const rawAmount = Number(item.amount || 0);
  const username = item.receiver_name || item.sender_name || item.description || "Unknown";
  return {
    id: String(item.id),
    username,
    amount: Number.isFinite(rawAmount) ? rawAmount : 0,
    type,
    status: mapStatus(item.status),
  };
}

function Pagination({
  currentPage,
  totalPages,
  onPageChange,
  isDarkTheme = true,
}: {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  isDarkTheme?: boolean;
}) {
  if (totalPages <= 1) return null;

  const pages = Array.from({ length: totalPages }, (_, i) => i + 1);

  return (
    <div className="flex items-center gap-1.5 sm:gap-2">
      <button
        type="button"
        onClick={() => onPageChange(Math.max(1, currentPage - 1))}
        className={`rounded-lg border px-2 sm:px-3 py-1 sm:py-1.5 text-[10px] sm:text-xs font-medium transition disabled:opacity-50 ${isDarkTheme ? 'border-white/10 bg-[#0E1118] text-gray-300 hover:bg-white/10' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
        disabled={currentPage === 1}
      >
        Prev
      </button>
      {pages.map((page) => (
        <button
          key={page}
          type="button"
          onClick={() => onPageChange(page)}
          className={`h-6 w-6 sm:h-7 sm:w-7 rounded-md text-[10px] sm:text-xs font-semibold transition ${
            page === currentPage
              ? isDarkTheme ? "bg-white text-gray-900" : "bg-gray-900 text-white"
              : isDarkTheme ? "border border-white/10 text-gray-300 hover:bg-white/10" : "border border-gray-200 text-gray-600 hover:bg-gray-50"
          }`}
        >
          {page}
        </button>
      ))}
      <button
        type="button"
        onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
        className={`rounded-lg border px-2 sm:px-3 py-1 sm:py-1.5 text-[10px] sm:text-xs font-medium transition disabled:opacity-50 ${isDarkTheme ? 'border-white/10 bg-[#0E1118] text-gray-300 hover:bg-white/10' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
        disabled={currentPage === totalPages}
      >
        Next
      </button>
    </div>
  );
}

function TransactionRow({ transaction, isDarkTheme = true }: { transaction: Transaction; isDarkTheme?: boolean }) {
  const isSend = transaction.type === "Send";
  const amountPrefix = isSend ? "-" : "+";
  const amountColor = isSend ? (isDarkTheme ? "text-rose-400" : "text-rose-600") : (isDarkTheme ? "text-emerald-400" : "text-emerald-600");

  const statusStyles: Record<StatusType, { dark: string; light: string }> = {
    completed: {
      dark: "border border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
      light: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    },
    pending: {
      dark: "border border-amber-500/40 bg-amber-500/10 text-amber-300",
      light: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
    },
    failed: {
      dark: "border border-rose-500/40 bg-rose-500/10 text-rose-300",
      light: "bg-rose-50 text-rose-700 ring-1 ring-rose-200",
    },
  };

  return (
    <div className={`grid min-w-[600px] sm:min-w-[760px] grid-cols-[1.6fr_1fr_1fr_1fr] items-center gap-2 sm:gap-4 rounded-xl sm:rounded-2xl border px-3 sm:px-5 py-2 sm:py-3 text-xs sm:text-sm transition ${isDarkTheme ? 'border-white/10 bg-[#0E1118] text-gray-200 hover:bg-white/5' : 'border-gray-200 bg-white text-gray-800 hover:bg-gray-50'}`}>
      <div className={`font-medium truncate ${isDarkTheme ? 'text-gray-100' : 'text-gray-900'}`}>{transaction.username}</div>
      <div className={`font-semibold ${amountColor}`}>
        {amountPrefix}${transaction.amount.toFixed(2)}
      </div>
      <div className={`truncate ${isDarkTheme ? 'text-gray-400' : 'text-gray-600'}`}>{transaction.type}</div>
      <div>
        <span className={`inline-flex items-center rounded-full px-2 sm:px-3 py-0.5 sm:py-1 text-[10px] sm:text-xs font-semibold ${isDarkTheme ? statusStyles[transaction.status].dark : statusStyles[transaction.status].light}`}>
          {transaction.status}
        </span>
      </div>
    </div>
  );
}

export function TransactionHistorySection({
  refreshTrigger,
  userEmail,
  isDarkTheme = true,
}: {
  refreshTrigger?: number;
  userEmail?: string;
  isDarkTheme?: boolean;
}) {
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const email = userEmail?.trim();
    if (!email) return;

    let cancelled = false;
    const loadTransactions = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const tokenRes = await loggedFetch(
          `${TOPUPGO_ACCOUNT_EXISTS_API}?email=${encodeURIComponent(email)}`,
          {
            headers: {
              accept: "application/json",
              ...(TOPUPGO_CSRF_TOKEN ? { "X-CSRFTOKEN": TOPUPGO_CSRF_TOKEN } : {}),
            },
            logLabel: "TopupGo transaction history token",
          }
        );
        const tokenJson = await tokenRes.json().catch(() => null);
        const accessToken = tokenJson?.access_token ?? null;
        if (!accessToken) {
          if (!cancelled) setError("Could not fetch transaction history token.");
          return;
        }

        const response = await loggedFetch(TOPUPGO_TRANSACTIONS_API, {
          headers: {
            accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
            ...(TOPUPGO_CSRF_TOKEN ? { "X-CSRFTOKEN": TOPUPGO_CSRF_TOKEN } : {}),
          },
          logLabel: "TopupGo transactions list",
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          console.error("[TransactionHistory] list failed", { status: response.status, errorText });
          if (!cancelled) setError("Failed to fetch transactions.");
          return;
        }

        const json = await response.json().catch(() => null);
        const list: ApiTransaction[] = Array.isArray(json)
          ? json
          : Array.isArray(json?.results)
            ? json.results
            : Array.isArray(json?.data)
              ? json.data
              : [];
        if (!cancelled) {
          setRows(list.map(mapTransaction));
          setPage(1);
        }
      } catch (err) {
        console.error("[TransactionHistory] fetch error", err);
        if (!cancelled) setError("Failed to fetch transactions.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    loadTransactions();
    const interval = setInterval(loadTransactions, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [refreshTrigger, userEmail]);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));

  const currentRows = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return rows.slice(start, start + PAGE_SIZE);
  }, [page, rows]);

  return (
    <div className={`rounded-[12px] sm:rounded-[18px] border p-4 sm:p-6 ${isDarkTheme ? 'border-white/10 bg-[#141923] shadow-[0_12px_30px_rgba(0,0,0,0.35)]' : 'border-gray-200 bg-white shadow-sm'}`}>
      <div className="mb-3 sm:mb-4 flex items-center gap-2">
        <svg className={`h-4 w-4 sm:h-5 sm:w-5 ${isDarkTheme ? 'text-orange-400' : 'text-gray-600'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01" />
        </svg>
        <h2 className={`text-base sm:text-lg font-semibold ${isDarkTheme ? 'text-white' : 'text-gray-900'}`}>Recent Transactions</h2>
      </div>

      <div className={`rounded-xl sm:rounded-2xl border ${isDarkTheme ? 'border-white/10' : 'border-gray-200'}`}>
        <div className="max-h-[400px] sm:max-h-[520px] overflow-x-auto overflow-y-auto">
          <div className={`sticky top-0 z-10 min-w-[600px] sm:min-w-[760px] border-b text-[10px] sm:text-xs font-semibold uppercase tracking-wide ${isDarkTheme ? 'border-white/10 bg-[#121722] text-gray-500' : 'border-gray-200 bg-slate-50 text-slate-500'}`}>
            <div className="grid grid-cols-[1.6fr_1fr_1fr_1fr] gap-2 sm:gap-4 px-3 sm:px-5 py-2 sm:py-3">
              <span>Username</span>
              <span>Amount</span>
              <span>Type</span>
              <span>Status</span>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:gap-3 px-2 sm:px-3 py-3 sm:py-4">
            {isLoading && <div className={`py-6 sm:py-8 text-center text-xs sm:text-sm ${isDarkTheme ? 'text-gray-400' : 'text-gray-500'}`}>Loading transactions...</div>}
            {!isLoading && error && <div className={`py-6 sm:py-8 text-center text-xs sm:text-sm ${isDarkTheme ? 'text-red-300' : 'text-red-500'}`}>{error}</div>}
            {!isLoading && !error && currentRows.length === 0 && (
              <div className={`py-6 sm:py-8 text-center text-xs sm:text-sm ${isDarkTheme ? 'text-gray-400' : 'text-gray-500'}`}>No transactions found.</div>
            )}
            {!isLoading && !error && currentRows.map((transaction) => (
              <TransactionRow key={transaction.id} transaction={transaction} isDarkTheme={isDarkTheme} />
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 sm:mt-4 flex justify-end">
        <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} isDarkTheme={isDarkTheme} />
      </div>
    </div>
  );
}
