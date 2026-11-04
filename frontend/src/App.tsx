import { useState } from "react";
import { IssuerPanel } from "./components/IssuerPanel";
import { VerifierPanel } from "./components/VerifierPanel";
import "./App.css";

type Tab = "issuer" | "verifier";

export default function App() {
  const [tab, setTab] = useState<Tab>("issuer");

  return (
    <div className="app">
      <header className="top">
        <div className="brand-block">
          <p className="eyebrow">ESPRIT · Blockchain · Sepolia</p>
          <h1>DiplomaChain</h1>
          <p className="tagline">
            Issue and verify diploma PDF hashes on-chain. Documents never leave
            your browser.
          </p>
        </div>
        <nav className="tabs" aria-label="Main">
          <button
            type="button"
            className={tab === "issuer" ? "tab active" : "tab"}
            onClick={() => setTab("issuer")}
          >
            Issuer
          </button>
          <button
            type="button"
            className={tab === "verifier" ? "tab active" : "tab"}
            onClick={() => setTab("verifier")}
          >
            Verifier
          </button>
        </nav>
      </header>

      <main key={tab} className="panel-shell">
        {tab === "issuer" ? <IssuerPanel /> : <VerifierPanel />}
      </main>

      <footer className="footer">
        No admin UI by design — issuer approvals are handled off-demo via scripts
        / Etherscan.
      </footer>
    </div>
  );
}
