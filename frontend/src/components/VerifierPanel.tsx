import { useState } from "react";
import {
  decodeContractError,
  ETHERSCAN_ADDRESS,
  formatTimestamp,
  getReadProvider,
  getRegistry,
  hashPdfFile,
  normalizeHash,
  REGISTRY_ADDRESS,
  shortAddress,
  STATUS_LABEL,
  type Status,
} from "../lib/ethereum";

type VerifyResult = {
  status: Status;
  issuer: string;
  issuedAt: bigint;
  revokedAt: bigint;
  issuerApproved: boolean;
  isValid: boolean;
};

const ZERO = "0x0000000000000000000000000000000000000000";

export function VerifierPanel() {
  const [hash, setHash] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);

  async function onPickFile(file: File | null) {
    setError(null);
    setResult(null);
    if (!file) return;
    try {
      const h = await hashPdfFile(file);
      setHash(h);
      setFileName(file.name);
    } catch (err) {
      setError(decodeContractError(err));
    }
  }

  async function verify() {
    setError(null);
    setResult(null);
    let certHash: string;
    try {
      certHash = normalizeHash(hash);
    } catch (err) {
      setError(decodeContractError(err));
      return;
    }

    setBusy(true);
    try {
      const provider = getReadProvider();
      // BrowserProvider may need a dummy call to settle; JsonRpcProvider is fine as-is.
      const registry = getRegistry(provider);
      const [isValid, verified] = await Promise.all([
        registry.isValid(certHash) as Promise<boolean>,
        registry.verifyCertificate(certHash) as Promise<{
          status: bigint;
          issuer: string;
          issuedAt: bigint;
          revokedAt: bigint;
          issuerApproved: boolean;
        }>,
      ]);

      setResult({
        status: Number(verified.status) as Status,
        issuer: verified.issuer,
        issuedAt: verified.issuedAt,
        revokedAt: verified.revokedAt,
        issuerApproved: verified.issuerApproved,
        isValid,
      });
    } catch (err) {
      setError(decodeContractError(err));
    } finally {
      setBusy(false);
    }
  }

  const showAccreditationWarning =
    result !== null &&
    result.status === 1 &&
    result.issuerApproved === false;

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Verifier</h2>
        <p>
          Check a diploma hash on Sepolia. No wallet required — MetaMask is used
          if present, otherwise a public RPC.
        </p>
      </header>

      <div className="card-block">
        <label className="label" htmlFor="v-pdf">
          Diploma PDF (hashed locally)
        </label>
        <input
          id="v-pdf"
          type="file"
          accept="application/pdf,.pdf"
          onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
        />
        {fileName && <p className="hint">Selected: {fileName}</p>}

        <label className="label" htmlFor="v-hash">
          Certificate hash
        </label>
        <input
          id="v-hash"
          className="mono input"
          placeholder="0x… (paste a hash or choose a PDF above)"
          value={hash}
          onChange={(e) => setHash(e.target.value)}
        />

        <div className="actions">
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void verify()}
          >
            {busy ? "Verifying…" : "Verify certificate"}
          </button>
        </div>
      </div>

      {error && (
        <div className="flash err">
          <p>{error}</p>
        </div>
      )}

      {showAccreditationWarning && (
        <div className="flash warn" role="alert">
          <strong>Warning — issuing institution is no longer accredited.</strong>
          <p>
            This diploma hash is still marked <em>Valid</em> on-chain (it was not
            revoked), but the issuer is no longer approved in IssuerManager.
            Treat this result with caution.
          </p>
        </div>
      )}

      {result && (
        <div className="card-block result">
          <div className="result-grid">
            <div>
              <div className="label">Status</div>
              <div>
                <span
                  className={`badge ${
                    result.status === 1
                      ? "ok"
                      : result.status === 2
                        ? "err"
                        : ""
                  }`}
                >
                  {STATUS_LABEL[result.status]}
                </span>
              </div>
            </div>
            <div>
              <div className="label">isValid()</div>
              <div className="mono">{result.isValid ? "true" : "false"}</div>
            </div>
            <div>
              <div className="label">Issuer approved</div>
              <div>
                {result.status === 0 ? (
                  "—"
                ) : result.issuerApproved ? (
                  <span className="badge ok">Yes</span>
                ) : (
                  <span className="badge err">No</span>
                )}
              </div>
            </div>
            <div>
              <div className="label">Issuer</div>
              <div className="mono">
                {result.issuer === ZERO ? (
                  "—"
                ) : (
                  <a
                    href={ETHERSCAN_ADDRESS(result.issuer)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortAddress(result.issuer)}
                  </a>
                )}
              </div>
            </div>
            <div>
              <div className="label">Issued at</div>
              <div>{formatTimestamp(result.issuedAt)}</div>
            </div>
            <div>
              <div className="label">Revoked at</div>
              <div>{formatTimestamp(result.revokedAt)}</div>
            </div>
          </div>
        </div>
      )}

      <p className="hint mono">Registry: {REGISTRY_ADDRESS}</p>
    </section>
  );
}
