import { useCallback, useEffect, useState } from "react";
import { BrowserProvider, Contract, type Signer } from "ethers";
import type { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import IssuerManagerAbi from "../contracts/IssuerManagerAbi.json";
import {
  connectWallet,
  decodeContractError,
  ensureSepolia,
  ETHERSCAN_TX,
  getRegistry,
  hashPdfFile,
  hasMetaMask,
  normalizeHash,
  REGISTRY_ADDRESS,
  SEPOLIA_CHAIN_ID,
  shortAddress,
} from "../lib/ethereum";
import {
  buildBatchTree,
  downloadJson,
  makeProofBundle,
  proofsForTree,
  type BatchEntry,
} from "../lib/merkle";
import { FilePicker } from "./FilePicker";

type Props = {
  onAccountChange?: (address: string | null) => void;
};

type Flash = {
  type: "ok" | "err" | "info";
  text: string;
  tx?: string;
};

export function IssuerPanel({ onAccountChange }: Props) {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<bigint | null>(null);
  const [approved, setApproved] = useState<boolean | null>(null);
  const [signer, setSigner] = useState<Signer | null>(null);

  const [hash, setHash] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Flash | null>(null);

  const [batchEntries, setBatchEntries] = useState<BatchEntry[]>([]);
  const [batchRoot, setBatchRoot] = useState<string | null>(null);
  const [batchTree, setBatchTree] = useState<StandardMerkleTree<
    [string]
  > | null>(null);
  const [batchMessage, setBatchMessage] = useState<Flash | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [revokeRoot, setRevokeRoot] = useState("");
  const [revokeHash, setRevokeHash] = useState("");
  const [revokeProof, setRevokeProof] = useState("");

  const refreshApproval = useCallback(async (who: string, runner: Signer) => {
    try {
      const registry = getRegistry(runner);
      const managerAddr: string = await registry.issuerManager();
      const manager = new Contract(managerAddr, IssuerManagerAbi, runner);
      const ok: boolean = await manager.isApprovedIssuer(who);
      setApproved(ok);
    } catch {
      setApproved(null);
    }
  }, []);

  const connect = useCallback(async () => {
    setMessage(null);
    try {
      if (!hasMetaMask()) {
        setMessage({
          type: "err",
          text: "MetaMask is required on the Issuer page.",
        });
        return;
      }
      const { signer: s, address: addr, provider } = await connectWallet();
      await ensureSepolia(provider);
      const network = await provider.getNetwork();
      setSigner(s);
      setAddress(addr);
      setChainId(network.chainId);
      onAccountChange?.(addr);
      await refreshApproval(addr, s);
    } catch (err) {
      setMessage({ type: "err", text: decodeContractError(err) });
    }
  }, [onAccountChange, refreshApproval]);

  useEffect(() => {
    if (!window.ethereum?.on) return;
    const onAccounts = (accounts: unknown) => {
      const list = accounts as string[];
      if (!list.length) {
        setAddress(null);
        setSigner(null);
        setApproved(null);
        onAccountChange?.(null);
        return;
      }
      void connect();
    };
    const onChain = () => {
      void connect();
    };
    window.ethereum.on("accountsChanged", onAccounts);
    window.ethereum.on("chainChanged", onChain);
    return () => {
      window.ethereum?.removeListener?.("accountsChanged", onAccounts);
      window.ethereum?.removeListener?.("chainChanged", onChain);
    };
  }, [connect, onAccountChange]);

  async function ensureReady(): Promise<boolean> {
    if (!signer || !address) {
      setMessage({ type: "err", text: "Connect MetaMask first." });
      return false;
    }
    if (chainId !== SEPOLIA_CHAIN_ID) {
      try {
        const provider = new BrowserProvider(window.ethereum!);
        await ensureSepolia(provider);
        await connect();
      } catch (err) {
        setMessage({ type: "err", text: decodeContractError(err) });
        return false;
      }
    }
    return true;
  }

  async function onPickFile(file: File | null) {
    setMessage(null);
    if (!file) return;
    try {
      const h = await hashPdfFile(file);
      setHash(h);
      setFileName(file.name);
      setMessage({
        type: "info",
        text: "PDF hashed in the browser. The file never leaves your device.",
      });
    } catch (err) {
      setMessage({ type: "err", text: decodeContractError(err) });
    }
  }

  async function runTx(action: "issue" | "revoke") {
    setMessage(null);
    if (!(await ensureReady())) return;

    let certHash: string;
    try {
      certHash = normalizeHash(hash);
    } catch (err) {
      setMessage({ type: "err", text: decodeContractError(err) });
      return;
    }

    setBusy(true);
    try {
      const registry = getRegistry(signer!);
      const tx =
        action === "issue"
          ? await registry.issueCertificate(certHash)
          : await registry.revokeCertificate(certHash);
      setMessage({
        type: "info",
        text: "Transaction submitted — waiting for confirmation…",
        tx: tx.hash,
      });
      await tx.wait();
      setMessage({
        type: "ok",
        text:
          action === "issue"
            ? "Certificate issued successfully."
            : "Certificate revoked successfully.",
        tx: tx.hash,
      });
      await refreshApproval(address!, signer!);
    } catch (err) {
      setMessage({ type: "err", text: decodeContractError(err) });
    } finally {
      setBusy(false);
    }
  }

  async function onPickBatchFiles(files: FileList | null) {
    setBatchMessage(null);
    setBatchRoot(null);
    setBatchTree(null);
    if (!files?.length) return;
    try {
      const next: BatchEntry[] = [];
      for (const file of Array.from(files)) {
        next.push({ label: file.name, certHash: await hashPdfFile(file) });
      }
      setBatchEntries(next);
      setBatchMessage({
        type: "info",
        text: `${next.length} PDF(s) hashed locally. Click “Build Merkle tree”.`,
      });
    } catch (err) {
      setBatchMessage({ type: "err", text: decodeContractError(err) });
    }
  }

  function addBatchHashFromSingle() {
    setBatchMessage(null);
    try {
      const certHash = normalizeHash(hash);
      const label = fileName ?? shortAddress(certHash);
      setBatchEntries((prev) => {
        if (prev.some((e) => e.certHash.toLowerCase() === certHash.toLowerCase())) {
          return prev;
        }
        return [...prev, { label, certHash }];
      });
      setBatchRoot(null);
      setBatchTree(null);
      setBatchMessage({ type: "info", text: "Hash added to the batch list." });
    } catch (err) {
      setBatchMessage({ type: "err", text: decodeContractError(err) });
    }
  }

  function buildTree() {
    setBatchMessage(null);
    try {
      const { tree, entries, root } = buildBatchTree(batchEntries);
      setBatchEntries(entries);
      setBatchTree(tree);
      setBatchRoot(root);
      setRevokeRoot(root);
      setBatchMessage({
        type: "ok",
        text: `Merkle root ready (${entries.length} leaves). You can issue the batch and download proofs.`,
      });
    } catch (err) {
      setBatchMessage({ type: "err", text: decodeContractError(err) });
    }
  }

  function downloadProofs() {
    setBatchMessage(null);
    if (!batchTree || !batchRoot) {
      setBatchMessage({ type: "err", text: "Build the Merkle tree first." });
      return;
    }
    try {
      const entries = proofsForTree(batchTree, batchEntries);
      const bundle = makeProofBundle(batchRoot, entries);
      downloadJson(`diplomachain-batch-proofs-${Date.now()}.json`, bundle);
      setBatchMessage({
        type: "ok",
        text: "Proof bundle downloaded. Give each student their entry (hash + proof + root).",
      });
    } catch (err) {
      setBatchMessage({ type: "err", text: decodeContractError(err) });
    }
  }

  async function issueBatch() {
    setBatchMessage(null);
    if (!(await ensureReady())) {
      setBatchMessage({ type: "err", text: "Connect MetaMask on Sepolia first." });
      return;
    }
    if (!batchRoot) {
      setBatchMessage({ type: "err", text: "Build the Merkle tree first." });
      return;
    }

    setBatchBusy(true);
    try {
      const registry = getRegistry(signer!);
      const tx = await registry.issueBatch(batchRoot, batchEntries.length);
      setBatchMessage({
        type: "info",
        text: "Batch transaction submitted — waiting for confirmation…",
        tx: tx.hash,
      });
      await tx.wait();
      setBatchMessage({
        type: "ok",
        text: "Batch issued on-chain. Download proofs for students.",
        tx: tx.hash,
      });
      await refreshApproval(address!, signer!);
    } catch (err) {
      setBatchMessage({ type: "err", text: decodeContractError(err) });
    } finally {
      setBatchBusy(false);
    }
  }

  async function revokeBatchLeaf() {
    setBatchMessage(null);
    if (!(await ensureReady())) {
      setBatchMessage({ type: "err", text: "Connect MetaMask on Sepolia first." });
      return;
    }
    setBatchBusy(true);
    try {
      const root = normalizeHash(revokeRoot);
      const certHash = normalizeHash(revokeHash);
      const proof = JSON.parse(revokeProof.trim()) as string[];
      if (!Array.isArray(proof)) throw new Error("Proof must be a JSON array.");
      const registry = getRegistry(signer!);
      const tx = await registry.revokeBatchLeaf(root, certHash, proof);
      setBatchMessage({
        type: "info",
        text: "Revoke leaf submitted — waiting for confirmation…",
        tx: tx.hash,
      });
      await tx.wait();
      setBatchMessage({
        type: "ok",
        text: "Batch leaf revoked.",
        tx: tx.hash,
      });
    } catch (err) {
      setBatchMessage({ type: "err", text: decodeContractError(err) });
    } finally {
      setBatchBusy(false);
    }
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Issuer</h2>
        <p>Issue or revoke a diploma hash. Only approved issuers can issue.</p>
      </header>

      <div className="card-block">
        {!address ? (
          <button type="button" className="btn primary" onClick={() => void connect()}>
            Connect MetaMask
          </button>
        ) : (
          <div className="wallet-row">
            <div>
              <div className="label">Connected</div>
              <div className="mono">{shortAddress(address)}</div>
            </div>
            <div>
              <div className="label">Network</div>
              <div>
                {chainId === SEPOLIA_CHAIN_ID ? (
                  <span className="badge ok">Sepolia</span>
                ) : (
                  <span className="badge err">Wrong network</span>
                )}
              </div>
            </div>
            <div>
              <div className="label">Issuer status</div>
              <div>
                {approved === null && <span className="badge">Unknown</span>}
                {approved === true && <span className="badge ok">Approved</span>}
                {approved === false && (
                  <span className="badge err">Not approved</span>
                )}
              </div>
            </div>
            <button type="button" className="btn" onClick={() => void connect()}>
              Refresh
            </button>
          </div>
        )}
      </div>

      <div className="card-block">
        <h3 className="section-title">Single certificate</h3>
        <FilePicker
          id="pdf"
          label="Diploma PDF (hashed locally)"
          accept="application/pdf,.pdf"
          fileName={fileName}
          onFiles={(files) => void onPickFile(files?.[0] ?? null)}
        />

        <label className="label" htmlFor="hash">
          Certificate hash
        </label>
        <input
          id="hash"
          className="mono input"
          placeholder="0x… (paste a hash or choose a PDF above)"
          value={hash}
          onChange={(e) => setHash(e.target.value)}
        />

        <div className="actions">
          <button
            type="button"
            className="btn primary"
            disabled={busy || !address}
            onClick={() => void runTx("issue")}
          >
            {busy ? "Working…" : "Issue certificate"}
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={busy || !address}
            onClick={() => void runTx("revoke")}
          >
            Revoke certificate
          </button>
          <button
            type="button"
            className="btn"
            disabled={!hash}
            onClick={addBatchHashFromSingle}
          >
            Add hash to batch
          </button>
        </div>
      </div>

      {message && (
        <div className={`flash ${message.type}`}>
          <p>{message.text}</p>
          {message.tx && (
            <p>
              Tx:{" "}
              <a href={ETHERSCAN_TX(message.tx)} target="_blank" rel="noreferrer">
                {shortAddress(message.tx)}
              </a>
            </p>
          )}
        </div>
      )}

      <div className="card-block">
        <h3 className="section-title">Merkle batch</h3>
        <p className="hint">
          Issue many diplomas in one transaction. Build the tree in the browser,
          publish the root, then download per-student proofs.{" "}
          <code>count</code> is informational only on-chain.
        </p>

        <FilePicker
          id="batch-pdfs"
          label="Multiple diploma PDFs"
          accept="application/pdf,.pdf"
          multiple
          buttonText="Choose files"
          fileName={
            batchEntries.length
              ? `${batchEntries.length} file${batchEntries.length > 1 ? "s" : ""} selected`
              : null
          }
          onFiles={(files) => void onPickBatchFiles(files)}
        />

        {batchEntries.length > 0 && (
          <ul className="batch-list mono">
            {batchEntries.map((e) => (
              <li key={e.certHash}>
                <strong>{e.label}</strong>
                <br />
                {e.certHash}
              </li>
            ))}
          </ul>
        )}

        {batchRoot && (
          <div className="root-box">
            <div className="label">Merkle root</div>
            <div className="mono">{batchRoot}</div>
          </div>
        )}

        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={batchEntries.length === 0 || batchBusy}
            onClick={buildTree}
          >
            Build Merkle tree
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!batchRoot || batchBusy || !address}
            onClick={() => void issueBatch()}
          >
            {batchBusy ? "Working…" : "Issue batch root"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!batchTree || batchBusy}
            onClick={downloadProofs}
          >
            Download proofs JSON
          </button>
          <button
            type="button"
            className="btn"
            disabled={batchBusy}
            onClick={() => {
              setBatchEntries([]);
              setBatchRoot(null);
              setBatchTree(null);
              setBatchMessage(null);
            }}
          >
            Clear batch
          </button>
        </div>

        <h3 className="section-title nested">Revoke one batch leaf</h3>
        <label className="label" htmlFor="revoke-root">
          Batch Merkle root
        </label>
        <input
          id="revoke-root"
          className="mono input"
          value={revokeRoot}
          onChange={(e) => setRevokeRoot(e.target.value)}
          placeholder="0x…"
        />
        <label className="label" htmlFor="revoke-hash">
          Certificate hash
        </label>
        <input
          id="revoke-hash"
          className="mono input"
          value={revokeHash}
          onChange={(e) => setRevokeHash(e.target.value)}
          placeholder="0x…"
        />
        <label className="label" htmlFor="revoke-proof">
          Merkle proof (JSON array)
        </label>
        <textarea
          id="revoke-proof"
          className="mono input textarea"
          rows={3}
          value={revokeProof}
          onChange={(e) => setRevokeProof(e.target.value)}
          placeholder='["0x…", "0x…"]'
        />
        <div className="actions">
          <button
            type="button"
            className="btn danger"
            disabled={batchBusy || !address}
            onClick={() => void revokeBatchLeaf()}
          >
            Revoke batch leaf
          </button>
        </div>
      </div>

      {batchMessage && (
        <div className={`flash ${batchMessage.type}`}>
          <p>{batchMessage.text}</p>
          {batchMessage.tx && (
            <p>
              Tx:{" "}
              <a
                href={ETHERSCAN_TX(batchMessage.tx)}
                target="_blank"
                rel="noreferrer"
              >
                {shortAddress(batchMessage.tx)}
              </a>
            </p>
          )}
        </div>
      )}

      <p className="hint mono">Registry: {REGISTRY_ADDRESS}</p>
    </section>
  );
}
