import { useCallback, useEffect, useState } from "react";
import { ConsortiumPanel } from "./components/ConsortiumPanel";
import { IssuerPanel } from "./components/IssuerPanel";
import { SignInPanel } from "./components/SignInPanel";
import { VerifierPanel } from "./components/VerifierPanel";
import { currentAccount, loadSession, signOut, type Session } from "./lib/auth";
import {
  getInstitution,
  INSTITUTION_STATUS_LABEL,
  shortAddress,
  type Institution,
} from "./lib/ethereum";
import "./App.css";

type Tab = "signin" | "issuer" | "consortium" | "verifier";

/** Members issue; removed / departed institutions keep the Issuer page to revoke their own diplomas. */
const CAN_USE_ISSUER = new Set([2, 4, 5]);

export default function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const [institution, setInstitution] = useState<Institution | null>(null);
  // "issuer" falls back to the first available tab (Consortium) for non-members.
  const [tab, setTab] = useState<Tab>(session ? "issuer" : "signin");

  const refreshInstitution = useCallback(async () => {
    if (!session) {
      setInstitution(null);
      return;
    }
    try {
      setInstitution(await getInstitution(session.address));
    } catch {
      setInstitution(null);
    }
  }, [session]);

  useEffect(() => {
    void refreshInstitution();
  }, [refreshInstitution]);

  const handleSignOut = useCallback(() => {
    signOut();
    setSession(null);
    setInstitution(null);
    setTab("signin");
  }, []);

  // A session belongs to one wallet: switching account in MetaMask signs out.
  useEffect(() => {
    if (!session) return;
    void currentAccount().then((account) => {
      if (account !== session.address) handleSignOut();
    });
    if (!window.ethereum?.on) return;
    const onAccounts = (accounts: unknown) => {
      const list = accounts as string[];
      if (!list.length || list[0].toLowerCase() !== session.address.toLowerCase()) handleSignOut();
    };
    window.ethereum.on("accountsChanged", onAccounts);
    return () => window.ethereum?.removeListener?.("accountsChanged", onAccounts);
  }, [session, handleSignOut]);

  const canIssue = institution !== null && CAN_USE_ISSUER.has(institution.status);

  function handleSignedIn(next: Session) {
    setSession(next);
    setTab("issuer");
  }

  const tabs: Array<{ id: Tab; label: string }> = session
    ? [
        ...(canIssue ? [{ id: "issuer" as const, label: "Issuer" }] : []),
        { id: "consortium", label: "Consortium" },
        { id: "verifier", label: "Verifier" },
      ]
    : [
        { id: "signin", label: "Sign in" },
        { id: "verifier", label: "Verifier" },
      ];

  const activeTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;

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
        <div className="top-side">
          {session && (
            <div className="identity">
              <div>
                <strong>{institution?.name || "Unregistered wallet"}</strong>
                <span className="mono">{shortAddress(session.address)}</span>
              </div>
              {institution && (
                <span className={`badge ${institution.status === 2 ? "ok" : ""}`}>
                  {INSTITUTION_STATUS_LABEL[institution.status]}
                </span>
              )}
              <button type="button" className="btn small" onClick={handleSignOut}>
                Sign out
              </button>
            </div>
          )}
          <nav className="tabs" aria-label="Main">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                className={activeTab === t.id ? "tab active" : "tab"}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* Panels stay mounted so form state survives tab switches. */}
      {!session && (
        <main className="panel-shell" hidden={activeTab !== "signin"}>
          <SignInPanel onSignedIn={handleSignedIn} onOpenVerifier={() => setTab("verifier")} />
        </main>
      )}
      {session && canIssue && (
        <main className="panel-shell" hidden={activeTab !== "issuer"}>
          <IssuerPanel key={session.address} />
        </main>
      )}
      {session && (
        <main className="panel-shell" hidden={activeTab !== "consortium"}>
          <ConsortiumPanel
            key={session.address}
            address={session.address}
            institution={institution}
            onChanged={() => void refreshInstitution()}
          />
        </main>
      )}
      <main className="panel-shell" hidden={activeTab !== "verifier"}>
        <VerifierPanel />
      </main>

      <footer className="footer">
        No admin: institutions are admitted and removed by a vote of the consortium members.
      </footer>
    </div>
  );
}
