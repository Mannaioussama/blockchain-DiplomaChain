import { useCallback, useEffect, useState } from "react";
import { BrowserProvider, Contract, type Signer } from "ethers";
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

type Props = {
  onAccountChange?: (address: string | null) => void;
};

export function IssuerPanel({ onAccountChange }: Props) {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<bigint | null>(null);
  const [approved, setApproved] = useState<boolean | null>(null);
  const [signer, setSigner] = useState<Signer | null>(null);
  const [hash, setHash] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    type: "ok" | "err" | "info";
    text: string;
    tx?: string;
  } | null>(null);

  const refreshApproval = useCallback(async (who: string, runner: Signer) => {
    try {
      const registry = getRegistry(runner);
      // Live address from the registry (immutable), then approval check.
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

  async function onPickFile(file: File | null) {
    setMessage(null);
    if (!file) return;
    try {
      const h = await hashPdfFile(file);
      setHash(h);
      setFileName(file.name);
      setMessage({
        type: "info",
        text: `PDF hashed in the browser. The file never leaves your device.`,
      });
    } catch (err) {
      setMessage({ type: "err", text: decodeContractError(err) });
    }
  }

  async function runTx(action: "issue" | "revoke") {
    setMessage(null);
    if (!signer || !address) {
      setMessage({ type: "err", text: "Connect MetaMask first." });
      return;
    }
    if (chainId !== SEPOLIA_CHAIN_ID) {
      setMessage({ type: "err", text: "Switch MetaMask to Sepolia first." });
      try {
        const provider = new BrowserProvider(window.ethereum!);
        await ensureSepolia(provider);
        await connect();
      } catch (err) {
        setMessage({ type: "err", text: decodeContractError(err) });
      }
      return;
    }

    let certHash: string;
    try {
      certHash = normalizeHash(hash);
    } catch (err) {
      setMessage({ type: "err", text: decodeContractError(err) });
      return;
    }

    setBusy(true);
    try {
      const registry = getRegistry(signer);
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
      await refreshApproval(address, signer);
    } catch (err) {
      setMessage({ type: "err", text: decodeContractError(err) });
    } finally {
      setBusy(false);
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
        <label className="label" htmlFor="pdf">
          Diploma PDF (hashed locally)
        </label>
        <input
          id="pdf"
          type="file"
          accept="application/pdf,.pdf"
          onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
        />
        {fileName && <p className="hint">Selected: {fileName}</p>}

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

      <p className="hint mono">Registry: {REGISTRY_ADDRESS}</p>
    </section>
  );
}
