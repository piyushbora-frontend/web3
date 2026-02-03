import { useWeb3AuthConnect, useWeb3AuthDisconnect, useWeb3AuthUser, useWalletUI } from "@web3auth/modal/react";
import { useAccount } from "wagmi";
import { SendTransaction } from "./wagmi/sendTransaction";
import { Balance } from "./wagmi/getBalance";
import { SwitchChain } from "./wagmi/switchNetwork";

function App() {
  const { connect, isConnected, loading: connectLoading, error: connectError } = useWeb3AuthConnect();
  // IMP START - Logout
  const { disconnect, loading: disconnectLoading, error: disconnectError } = useWeb3AuthDisconnect();
  const { userInfo } = useWeb3AuthUser();
  const { showWalletUI, loading: walletUiLoading, error: walletUiError } = useWalletUI();
  const { address, connector } = useAccount();

  function uiConsole(...args: any[]): void {
    const el = document.querySelector("#console>p");
    if (el) {
      el.innerHTML = JSON.stringify(args || {}, null, 2);
      console.log(...args);
    }
  }

  const loggedInView = (
    <div className="grid">
      <h2>Connected to {connector?.name}</h2>
      <div>{address}</div>
      <div className="flex-container">
        <div>
          <button onClick={() => uiConsole(userInfo)} className="card">
            Get User Info
          </button>
        </div>
        <div>
          <button
            onClick={() => showWalletUI({ show: true, path: "wallet/funding" })}
            className="card"
            disabled={walletUiLoading}
          >
            {walletUiLoading ? "Opening..." : "Buy Crypto / Add Funds"}
          </button>
          {walletUiError && <div className="error">{walletUiError.message}</div>}
        </div>
        <div>
          <button onClick={() => disconnect()} className="card">
            Log Out
          </button>
          {disconnectLoading && <div className="loading">Disconnecting...</div>}
          {disconnectError && <div className="error">{disconnectError.message}</div>}
        </div>
      </div>
      <SendTransaction />
      <Balance />
      <SwitchChain />
    </div>
  );

  const unloggedInView = (
    <div className="grid">
      <button onClick={() => connect()} className="card">
        Login
      </button>
      {connectLoading && <div className="loading">Connecting...</div>}
      {connectError && <div className="error">{connectError.message}</div>}
    </div>
  );

  return (
    <div className="container">
      <h1 className="title">
        <a target="_blank" href="https://web3auth.io/docs/sdk/pnp/web/modal" rel="noreferrer">
          Web3Auth{" "}
        </a>
        & Next.js Modal Quick Start
      </h1>

      {isConnected ? loggedInView : unloggedInView}
      <div id="console" style={{ whiteSpace: "pre-line" }}>
        <p style={{ whiteSpace: "pre-line" }}></p>
      </div>

      <footer className="footer">
        <a
          href="https://github.com/Web3Auth/web3auth-examples/tree/main/quick-starts/nextjs-quick-start"
          target="_blank"
          rel="noopener noreferrer"
        >
          Source code
        </a>
      </footer>
    </div>
  );
}

export default App;
