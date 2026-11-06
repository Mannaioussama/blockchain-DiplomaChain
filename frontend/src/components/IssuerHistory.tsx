import { useCallback, useEffect, useState } from "react";
import {
  decodeContractError,
  ETHERSCAN_TX,
  formatTimestamp,
  shortAddress,
} from "../lib/ethereum";
import { fetchIssuerHistory, labelFor, type HistoryItem, type HistoryKind } from "../lib/history";

type Props = {
  address: string;
  /** Bump to reload after a transaction. */
  refreshKey: number;
};

const KIND_LABEL: Record<HistoryKind, string> = {
  issued: "Issued",
  revoked: "Revoked",
  batchIssued: "Batch issued",
  batchLeafRevoked: "Batch leaf revoked",
};

const KIND_BADGE: Record<HistoryKind, string> = {
  issued: "ok",
  revoked: "err",
  batchIssued: "ok",
  batchLeafRevoked: "err",
};

type Filter = "all" | "single" | "batch";

function HashLine({ title, hash }: { title: string; hash: string }) {
  const name = labelFor(hash);
  return (
    <div className="history-hash">
      <span className="label">{title}</span>
      {name && <strong>{name}</strong>}
      <span className="mono">{hash}</span>
    </div>
  );
}

export function IssuerHistory({ address, refreshKey }: Props) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await fetchIssuerHistory(address));
    } catch (err) {
      setError(decodeContractError(err));
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const visible = (items ?? []).filter((item) => {
    if (filter === "single") return item.kind === "issued" || item.kind === "revoked";
    if (filter === "batch") return item.kind === "batchIssued" || item.kind === "batchLeafRevoked";
    return true;
  });

  const counts = {
    issued: items?.filter((i) => i.kind === "issued").length ?? 0,
    revoked: items?.filter((i) => i.kind === "revoked").length ?? 0,
    batches: items?.filter((i) => i.kind === "batchIssued").length ?? 0,
    leaves: items?.filter((i) => i.kind === "batchLeafRevoked").length ?? 0,
  };

  return (
    <div className="card-block">
      <div className="history-head">
        <h3 className="section-title">History</h3>
        <button type="button" className="btn" disabled={loading} onClick={() => void load()}>
          {loading ? "Loading…" : "Refresh history"}
        </button>
      </div>
      <p className="hint">
        Read from the contract’s on-chain events for {shortAddress(address)}. Names appear for
        PDFs hashed in this browser.
      </p>

      {items && (
        <div className="history-stats">
          <span>
            <strong>{counts.issued}</strong> issued
          </span>
          <span>
            <strong>{counts.revoked}</strong> revoked
          </span>
          <span>
            <strong>{counts.batches}</strong> batches
          </span>
          <span>
            <strong>{counts.leaves}</strong> batch leaves revoked
          </span>
        </div>
      )}

      <div className="history-filters" role="tablist" aria-label="History filter">
        {(["all", "single", "batch"] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={filter === f ? "chip active" : "chip"}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? "All" : f === "single" ? "Single certificates" : "Merkle batches"}
          </button>
        ))}
      </div>

      {error && (
        <div className="flash err">
          <p>Could not load history: {error}</p>
        </div>
      )}

      {items && visible.length === 0 && !loading && (
        <p className="hint">No activity yet for this filter.</p>
      )}

      {visible.length > 0 && (
        <ul className="history-list">
          {visible.map((item) => (
            <li key={`${item.txHash}-${item.logIndex}`} className="history-item">
              <div className="history-row">
                <span className={`badge ${KIND_BADGE[item.kind]}`}>{KIND_LABEL[item.kind]}</span>
                {item.kind === "batchIssued" && (
                  <span className="history-meta">{item.count} diplomas</span>
                )}
                <span className="history-meta">{formatTimestamp(item.timestamp)}</span>
                <a
                  className="history-tx mono"
                  href={ETHERSCAN_TX(item.txHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Tx {shortAddress(item.txHash)}
                </a>
              </div>
              {item.merkleRoot && <HashLine title="Merkle root" hash={item.merkleRoot} />}
              {item.certHash && <HashLine title="Certificate hash" hash={item.certHash} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
