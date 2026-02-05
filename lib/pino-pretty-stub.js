/**
 * Stub for pino-pretty (optional dependency of pino in WalletConnect).
 * Not needed for browser; export no-op.
 */
export default function noop() {
  return (chunk) => chunk;
}
