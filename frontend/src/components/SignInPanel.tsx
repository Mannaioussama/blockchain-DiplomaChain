import { useState } from "react";
import { signIn, type Session } from "../lib/auth";
import { decodeContractError, hasMetaMask } from "../lib/ethereum";

type Props = {
  onSignedIn: (session: Session) => void;
  onOpenVerifier: () => void;
};

export function SignInPanel({ onSignedIn, onOpenVerifier }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    setError(null);
    setBusy(true);
    try {
      onSignedIn(await signIn());
    } catch (err) {
      setError(decodeContractError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Sign in</h2>
        <p>
          No email, no password: your MetaMask wallet is your identity. The app reads your
          institution’s status directly from the consortium contract.
        </p>
      </header>

      <div className="card-block">
        <ol className="steps">
          <li>
            <strong>Connect MetaMask</strong> on the Sepolia network.
          </li>
          <li>
            <strong>Sign a message</strong> to prove you own the wallet. It is free and sends no
            transaction.
          </li>
          <li>
            <strong>Get your pages</strong>: member institutions can issue diplomas and vote; other
            institutions can apply to join.
          </li>
        </ol>

        <div className="actions">
          <button
            type="button"
            className="btn primary"
            disabled={busy || !hasMetaMask()}
            onClick={() => void handleSignIn()}
          >
            {busy ? "Waiting for MetaMask…" : "Sign in with MetaMask"}
          </button>
          <button type="button" className="btn" onClick={onOpenVerifier}>
            Verify a diploma (no sign-in)
          </button>
        </div>

        {!hasMetaMask() && (
          <p className="hint">
            MetaMask was not detected. Use Chrome with the MetaMask extension to sign in. Anyone can
            still use the Verifier.
          </p>
        )}
      </div>

      {error && (
        <div className="flash err">
          <p>{error}</p>
        </div>
      )}
    </section>
  );
}
