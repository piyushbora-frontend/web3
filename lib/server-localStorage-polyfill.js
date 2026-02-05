/**
 * Safe localStorage stub for Node/SSR. Prevents "localStorage.getItem is not a function"
 * when Web3Auth or other libs run during server render.
 */
if (typeof window === "undefined") {
  const stub = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    length: 0,
    key: () => null,
  };
  if (typeof globalThis !== "undefined") globalThis.localStorage = stub;
  if (typeof global !== "undefined") global.localStorage = stub;
}
