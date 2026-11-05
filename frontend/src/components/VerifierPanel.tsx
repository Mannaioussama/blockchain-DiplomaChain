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
import { parseProofInput } from "../lib/merkle";
import { FilePicker } from "./FilePicker";

type VerifyResult = {
  status: Status;
  issuer: string;
  issuedAt: bigint;
  revokedAt: bigint;
  issuerApproved: boolean;
  isValid: boolean;
};

type BatchVerifyResult = {
  valid: boolean;
  issuer: string;
  issuedAt: bigint;
  revoked: boolean;
  issuerApproved: boolean;
};

const ZERO = "0x0000000000000000000000000000000000000000";

export function VerifierPanel() {
  const [hash, setHash] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);

  const [batchRoot, setBatchRoot] = useState("");
  const [batchHash, setBatchHash] = useState("");
  const [batchProof, setBatchProof] = useState("");
  const [batchFileName, setBatchFileName] = useState<string | null>(null);
  const [bundleFileName, setBundleFileName] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchResult, setBatchResult] = useState<BatchVerifyResult | null>(null);

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

  async function onPickBatchFile(file: File | null) {
    setBatchError(null);
    setBatchResult(null);
    if (!file) return;
    try {
      setBatchHash(await hashPdfFile(file));
      setBatchFileName(file.name);
    } catch (err) {
      setBatchError(decodeContractError(err));
    }
  }

  async function onPickProofBundle(file: File | null) {
    setBatchError(null);
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text) as {
        merkleRoot?: string;
        entries?: Array<{ certHash: string; proof: string[] }>;
      };
      setBundleFileName(file.name);
      if (json.merkleRoot) setBatchRoot(json.merkleRoot);
      if (batchHash && json.entries?.length) {
        const entry = json.entries.find(
          (e) => e.certHash.toLowerCase() === batchHash.toLowerCase()
        );
        if (entry) {
          setBatchProof(JSON.stringify(entry.proof, null, 2));
        }
      } else if (json.entries?.length === 1) {
        setBatchHash(json.entries[0].certHash);
        setBatchProof(JSON.stringify(json.entries[0].proof, null, 2));
      }
    } catch (err) {
      setBatchError(decodeContractError(err));
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

  async function verifyBatch() {
    setBatchError(null);
    setBatchResult(null);
    setBatchBusy(true);
    try {
      const root = normalizeHash(batchRoot);
      const certHash = normalizeHash(batchHash);
      const proof = parseProofInput(batchProof);
      const provider = getReadProvider();
      const registry = getRegistry(provider);
      const verified = (await registry.verifyInBatch(root, certHash, proof)) as {
        valid: boolean;
        issuer: string;
        issuedAt: bigint;
        revoked: boolean;
        issuerApproved: boolean;
      };
      setBatchResult({
        valid: verified.valid,
        issuer: verified.issuer,
        issuedAt: verified.issuedAt,
        revoked: verified.revoked,
        issuerApproved: verified.issuerApproved,
      });
    } catch (err) {
      setBatchError(decodeContractError(err));
    } finally {
      setBatchBusy(false);
    }
  }

  const showAccreditationWarning =
    result !== null && result.status === 1 && result.issuerApproved === false;

  const showBatchWarning =
    batchResult !== null &&
    batchResult.valid &&
    batchResult.issuerApproved === false;

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
        <h3 className="section-title">Single certificate</h3>
        <FilePicker
          id="v-pdf"
          label="Diploma PDF (hashed locally)"
          accept="application/pdf,.pdf"
          fileName={fileName}
          onFiles={(files) => void onPickFile(files?.[0] ?? null)}
        />

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

      <div className="card-block">
        <h3 className="section-title">Verify in Merkle batch</h3>
        <p className="hint">
          Needs the batch Merkle root, the diploma hash, and that diploma’s
          Merkle proof (from the issuer’s JSON download).
        </p>

        <FilePicker
          id="b-pdf"
          label="Diploma PDF (optional)"
          accept="application/pdf,.pdf"
          fileName={batchFileName}
          onFiles={(files) => void onPickBatchFile(files?.[0] ?? null)}
        />

        <FilePicker
          id="b-bundle"
          label="Proof bundle JSON (optional auto-fill)"
          accept="application/json,.json"
          buttonText="Choose JSON"
          fileName={bundleFileName}
          onFiles={(files) => void onPickProofBundle(files?.[0] ?? null)}
        />

        <label className="label" htmlFor="b-root">
          Merkle root
        </label>
        <input
          id="b-root"
          className="mono input"
          value={batchRoot}
          onChange={(e) => setBatchRoot(e.target.value)}
          placeholder="0x…"
        />

        <label className="label" htmlFor="b-hash">
          Certificate hash
        </label>
        <input
          id="b-hash"
          className="mono input"
          value={batchHash}
          onChange={(e) => setBatchHash(e.target.value)}
          placeholder="0x…"
        />

        <label className="label" htmlFor="b-proof">
          Merkle proof (JSON array)
        </label>
        <textarea
          id="b-proof"
          className="mono input textarea"
          rows={4}
          value={batchProof}
          onChange={(e) => setBatchProof(e.target.value)}
          placeholder='["0x…", "0x…"]'
        />

        <div className="actions">
          <button
            type="button"
            className="btn primary"
            disabled={batchBusy}
            onClick={() => void verifyBatch()}
          >
            {batchBusy ? "Verifying…" : "Verify in batch"}
          </button>
        </div>
      </div>

      {batchError && (
        <div className="flash err">
          <p>{batchError}</p>
        </div>
      )}

      {showBatchWarning && (
        <div className="flash warn" role="alert">
          <strong>Warning — issuing institution is no longer accredited.</strong>
          <p>
            This batch leaf is still valid (not revoked), but the issuer is no
            longer approved in IssuerManager.
          </p>
        </div>
      )}

      {batchResult && (
        <div className="card-block result">
          <div className="result-grid">
            <div>
              <div className="label">In batch &amp; valid</div>
              <div>
                <span className={`badge ${batchResult.valid ? "ok" : "err"}`}>
                  {batchResult.valid ? "Yes" : "No"}
                </span>
              </div>
            </div>
            <div>
              <div className="label">Revoked leaf</div>
              <div className="mono">{batchResult.revoked ? "true" : "false"}</div>
            </div>
            <div>
              <div className="label">Issuer approved</div>
              <div>
                {batchResult.issuer === ZERO ? (
                  "—"
                ) : batchResult.issuerApproved ? (
                  <span className="badge ok">Yes</span>
                ) : (
                  <span className="badge err">No</span>
                )}
              </div>
            </div>
            <div>
              <div className="label">Issuer</div>
              <div className="mono">
                {batchResult.issuer === ZERO ? (
                  "—"
                ) : (
                  <a
                    href={ETHERSCAN_ADDRESS(batchResult.issuer)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortAddress(batchResult.issuer)}
                  </a>
                )}
              </div>
            </div>
            <div>
              <div className="label">Batch issued at</div>
              <div>{formatTimestamp(batchResult.issuedAt)}</div>
            </div>
          </div>
        </div>
      )}

      <p className="hint mono">Registry: {REGISTRY_ADDRESS}</p>
    </section>
  );
}
