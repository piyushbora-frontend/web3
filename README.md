# Web3Auth + Next.js Quick Start (Metmask)

## Project Flow (Simple Explanation)

### 1) App Load
- `app/layout.tsx` में `Web3AuthProvider` wrap होता है.
- SSR के लिए cookies से state restore होती है (`cookieToWeb3AuthState`).

### 2) Login
- `app/page.tsx` → `components/App.tsx` render करता है.
- `useWeb3AuthConnect()` से login होता है.
- `useAccount()` से wallet address और connector मिलता है.

### 3) Add Funds (Buy Crypto)
- `App.tsx` में **Buy Crypto / Add Funds** button है.
- Button click पर `showWalletUI({ show: true, path: "wallet/funding" })` open होता है.
- User card / bank / UPI / QR से fund कर सकता है.

### 4) Balance (Native + USDC)
- Balance UI `components/wagmi/getBalance.tsx` में है.
- Embedded wallet provider से balance fetch होता है:
  - Native (MATIC/ETH) `provider.getBalance(address)`
  - USDC `ERC20.balanceOf(address)`
- अगर chain पर USDC address available नहीं है तो `0.00` दिखेगा.

### 5) Send Transaction
- `components/wagmi/sendTransaction.tsx` से tx भेजा जाता है.

### 6) Switch Chain
- `components/wagmi/switchNetwork.tsx` से chain switch होता है.
- Chain बदलने पर Balance re-fetch होता है.

## Files Overview
- `app/layout.tsx` → Provider + SSR setup
- `app/page.tsx` → Main page
- `components/App.tsx` → Main UI + Add Funds button
- `components/wagmi/getBalance.tsx` → Balance logic
- `components/wagmi/sendTransaction.tsx` → Send tx
- `components/wagmi/switchNetwork.tsx` → Switch chain
- `components/provider.tsx` → Web3Auth config + Wagmi Provider

## Run Project
```bash
npm install
npm run dev
```

Open:
```
http://localhost:3000
```

## Notes
- Client ID `components/provider.tsx` में है.
- Client Secret frontend में नहीं रखना चाहिए (security risk).
