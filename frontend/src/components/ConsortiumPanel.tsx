import { useCallback, useEffect, useState } from "react";
import { BrowserProvider, type Contract } from "ethers";
import {
  decodeContractError,
  ETHERSCAN_ADDRESS,
  ETHERSCAN_TX,
  formatTimestamp,
  getInstitution,
  getIssuerManager,
  getReadProvider,
  INSTITUTION_STATUS_LABEL,
  ISSUER_MANAGER_ADDRESS,
  shortAddress,
  type Institution,
} from "../lib/ethereum";

type Props = {
  address: string;
  institution: Institution | null;
  /** Called after any change so the app can refresh the signed-in institution. */
  onChanged: () => void;
};

type Flash = { type: "ok" | "err" | "info"; text: string; tx?: string };

/** Mirrors IssuerManager.ProposalKind / ProposalStatus. */
const KIND_LABEL = ["Admission", "Removal"] as const;
const PROPOSAL_STATUS_LABEL = ["—", "Open", "Approved", "Rejected", "Cancelled"] as const;
const PROPOSAL_BADGE = ["", "", "ok", "err", ""] as const;

type ProposalView = {
  id: number;
  kind: 0 | 1;
  status: number;
  target: string;
  targetName: string;
  proposer: string;
  createdAt: number;
  closedAt: number;
  yesVotes: number;
  noVotes: number;
  required: number;
  eligible: number;
  viewerVoted: boolean;
};

const MEMBER = 2;

export function ConsortiumPanel({ address, institution, onChanged }: Props) {
  const [members, setMembers] = useState<Institution[]>([]);
  const [proposals, setProposals] = useState<ProposalView[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Flash | null>(null);
  const [applyName, setApplyName] = useState("");
  const [showClosed, setShowClosed] = useState(false);

  const isMember = institution?.status === MEMBER;
  const me = address.toLowerCase();
  const myOpenProposal = proposals.find(
    (p) => p.status === 1 && p.target.toLowerCase() === me
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const manager = getIssuerManager(getReadProvider());
      const [memberAddrs, count] = (await Promise.all([
        manager.getMembers(),
        manager.proposalCount(),
      ])) as [string[], bigint];

      const memberInfos = await Promise.all(memberAddrs.map((a) => getInstitution(a)));
      const ids = Array.from({ length: Number(count) }, (_, i) => Number(count) - i);
      const views = await Promise.all(ids.map((id) => loadProposal(manager, id, address)));

      setMembers(memberInfos);
      setProposals(views);
    } catch (err) {
      setMessage({ type: "err", text: decodeContractError(err) });
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runTx(pending: string, done: string, send: (m: Contract) => Promise<{ hash: string; wait: () => Promise<unknown> }>) {
    setMessage(null);
    setBusy(true);
    try {
      const signer = await new BrowserProvider(window.ethereum!).getSigner();
      const tx = await send(getIssuerManager(signer));
      setMessage({ type: "info", text: pending, tx: tx.hash });
      await tx.wait();
      setMessage({ type: "ok", text: done, tx: tx.hash });
      await load();
      onChanged();
    } catch (err) {
      setMessage({ type: "err", text: decodeContractError(err) });
    } finally {
      setBusy(false);
    }
  }

  const apply = () =>
    runTx(
      "Application submitted — waiting for confirmation…",
      "Application recorded. Member institutions can now vote on it.",
      (m) => m.applyToJoin(applyName.trim())
    );

  const withdraw = () =>
    runTx("Withdrawing application…", "Application withdrawn.", (m) => m.withdrawApplication());

  const leave = () => {
    if (!window.confirm("Leave the consortium? Your institution will no longer be able to issue diplomas (already issued diplomas stay valid).")) return;
    void runTx("Leaving the consortium…", "Your institution left the consortium.", (m) => m.leave());
  };

  const vote = (id: number, support: boolean) =>
    runTx(
      `Vote ${support ? "YES" : "NO"} on proposal #${id} submitted…`,
      `Vote recorded on proposal #${id}.`,
      (m) => m.vote(id, support)
    );

  const proposeRemoval = (target: Institution) => {
    if (!window.confirm(`Propose removing ${target.name}? The other members will vote.`)) return;
    void runTx(
      "Removal proposal submitted…",
      `Removal of ${target.name} proposed. Members can now vote.`,
      (m) => m.proposeRemoval(target.address)
    );
  };

  const finalize = (id: number) =>
    runTx(`Closing proposal #${id}…`, `Proposal #${id} closed.`, (m) => m.finalize(id));

  const visibleProposals = showClosed ? proposals : proposals.filter((p) => p.status === 1);
  const status = institution?.status ?? 0;
  const canApply = !isMember && !myOpenProposal;

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Consortium</h2>
        <p>
          Institutions allowed to issue diplomas. There is no admin: member institutions vote to
          admit new institutions and to remove existing ones. A strict majority decides.
        </p>
      </header>

      <div className="card-block">
        <h3 className="section-title">Your institution</h3>
        <div className="wallet-row">
          <div>
            <div className="label">Name</div>
            <div>{institution?.name || "—"}</div>
          </div>
          <div>
            <div className="label">Wallet</div>
            <div className="mono">{shortAddress(address)}</div>
          </div>
          <div>
            <div className="label">Status</div>
            <div>
              <span className={`badge ${isMember ? "ok" : status === 0 || status === 1 ? "" : "err"}`}>
                {INSTITUTION_STATUS_LABEL[status]}
              </span>
            </div>
          </div>
        </div>

        {canApply && (
          <>
            <label className="label" htmlFor="apply-name">
              Institution name
            </label>
            <input
              id="apply-name"
              className="input"
              placeholder="e.g. Universite de Sousse"
              maxLength={64}
              value={applyName}
              onChange={(e) => setApplyName(e.target.value)}
            />
            <div className="actions">
              <button
                type="button"
                className="btn primary"
                disabled={busy || !applyName.trim()}
                onClick={() => void apply()}
              >
                {busy ? "Working…" : "Apply to join"}
              </button>
            </div>
            <p className="hint">
              Your application opens a vote. Once a majority of members votes yes, your wallet can
              issue diplomas.
            </p>
          </>
        )}

        {myOpenProposal?.kind === 0 && (
          <div className="flash info">
            <p>
              Your application (proposal #{myOpenProposal.id}) is waiting for votes:{" "}
              <strong>
                {myOpenProposal.yesVotes} / {myOpenProposal.required}
              </strong>{" "}
              yes votes needed.
            </p>
            <div className="actions">
              <button type="button" className="btn" disabled={busy} onClick={() => void withdraw()}>
                Withdraw application
              </button>
            </div>
          </div>
        )}

        {myOpenProposal?.kind === 1 && (
          <div className="flash warn">
            <p>
              A removal of your institution is being voted on (proposal #{myOpenProposal.id}). You
              cannot vote on it.
            </p>
          </div>
        )}

        {isMember && (
          <div className="actions">
            <button type="button" className="btn danger" disabled={busy} onClick={leave}>
              Leave the consortium
            </button>
          </div>
        )}
      </div>

      <div className="card-block">
        <div className="history-head">
          <h3 className="section-title">Members ({members.length})</h3>
          <button type="button" className="btn" disabled={loading} onClick={() => void load()}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        <ul className="history-list">
          {members.map((m) => {
            const self = m.address.toLowerCase() === me;
            const underVote = proposals.some(
              (p) => p.status === 1 && p.target.toLowerCase() === m.address.toLowerCase()
            );
            return (
              <li key={m.address} className="history-item">
                <div className="history-row">
                  <strong>{m.name}</strong>
                  {self && <span className="badge ok">You</span>}
                  {underVote && <span className="badge err">Removal vote open</span>}
                  <a
                    className="history-tx mono"
                    href={ETHERSCAN_ADDRESS(m.address)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortAddress(m.address)}
                  </a>
                </div>
                <div className="history-meta">Member since {formatTimestamp(m.updatedAt)}</div>
                {isMember && !self && !underVote && (
                  <div className="actions">
                    <button
                      type="button"
                      className="btn danger"
                      disabled={busy}
                      onClick={() => proposeRemoval(m)}
                    >
                      Propose removal
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="card-block">
        <div className="history-head">
          <h3 className="section-title">Proposals</h3>
        </div>
        <div className="history-filters">
          <button
            type="button"
            className={!showClosed ? "chip active" : "chip"}
            onClick={() => setShowClosed(false)}
          >
            Open ({proposals.filter((p) => p.status === 1).length})
          </button>
          <button
            type="button"
            className={showClosed ? "chip active" : "chip"}
            onClick={() => setShowClosed(true)}
          >
            All ({proposals.length})
          </button>
        </div>

        {visibleProposals.length === 0 && !loading && (
          <p className="hint">{showClosed ? "No proposals yet." : "No open proposals."}</p>
        )}

        <ul className="history-list">
          {visibleProposals.map((p) => {
            const open = p.status === 1;
            const isTarget = p.target.toLowerCase() === me;
            const canVote = open && isMember && !p.viewerVoted && !(p.kind === 1 && isTarget);
            const decided = p.yesVotes >= p.required || p.noVotes + p.required > p.eligible;
            return (
              <li key={p.id} className="history-item">
                <div className="history-row">
                  <span className="mono">#{p.id}</span>
                  <span className={`badge ${p.kind === 1 ? "err" : ""}`}>{KIND_LABEL[p.kind]}</span>
                  <strong>{p.targetName || shortAddress(p.target)}</strong>
                  <span className={`badge ${PROPOSAL_BADGE[p.status]}`}>
                    {PROPOSAL_STATUS_LABEL[p.status]}
                  </span>
                </div>
                <div className="vote-bar" aria-label="Votes">
                  <span>
                    Yes <strong>{p.yesVotes}</strong>
                  </span>
                  <span>
                    No <strong>{p.noVotes}</strong>
                  </span>
                  {open && (
                    <span>
                      Needed <strong>{p.required}</strong> of {p.eligible} voters
                    </span>
                  )}
                </div>
                <div className="history-meta">
                  {p.kind === 0 ? "Applied" : `Proposed by ${shortAddress(p.proposer)}`} on{" "}
                  {formatTimestamp(p.createdAt)}
                  {!open && ` · closed ${formatTimestamp(p.closedAt)}`}
                  {" · "}
                  <span className="mono">{shortAddress(p.target)}</span>
                </div>

                {open && (
                  <div className="actions">
                    {canVote && (
                      <>
                        <button
                          type="button"
                          className="btn primary"
                          disabled={busy}
                          onClick={() => void vote(p.id, true)}
                        >
                          Vote yes
                        </button>
                        <button
                          type="button"
                          className="btn danger"
                          disabled={busy}
                          onClick={() => void vote(p.id, false)}
                        >
                          Vote no
                        </button>
                      </>
                    )}
                    {p.viewerVoted && <span className="badge ok">You voted</span>}
                    {decided && (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => void finalize(p.id)}
                      >
                        Close (outcome decided)
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
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

      <p className="hint mono">IssuerManager: {ISSUER_MANAGER_ADDRESS}</p>
    </section>
  );
}

async function loadProposal(manager: Contract, id: number, viewer: string): Promise<ProposalView> {
  const [p, required, voted, members] = (await Promise.all([
    manager.getProposal(id),
    manager.requiredVotes(id),
    manager.hasVoted(id, viewer),
    manager.memberCount(),
  ])) as [
    {
      target: string;
      kind: bigint;
      status: bigint;
      createdAt: bigint;
      closedAt: bigint;
      proposer: string;
      yesVotes: bigint;
      noVotes: bigint;
    },
    bigint,
    boolean,
    bigint,
  ];
  const kind = Number(p.kind) as 0 | 1;
  const target = await getInstitution(p.target);
  return {
    id,
    kind,
    status: Number(p.status),
    target: p.target,
    targetName: target.name,
    proposer: p.proposer,
    createdAt: Number(p.createdAt),
    closedAt: Number(p.closedAt),
    yesVotes: Number(p.yesVotes),
    noVotes: Number(p.noVotes),
    required: Number(required),
    eligible: Number(members) - (kind === 1 ? 1 : 0),
    viewerVoted: voted,
  };
}
