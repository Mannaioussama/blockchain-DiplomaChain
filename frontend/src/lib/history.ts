import { BrowserProvider, Interface, JsonRpcProvider, type Provider } from "ethers";
import CertificateRegistryAbi from "../contracts/CertificateRegistryAbi.json";
import {
  DEPLOY_BLOCK,
  PUBLIC_SEPOLIA_RPC,
  REGISTRY_ADDRESS,
  SEPOLIA_CHAIN_ID,
} from "./ethereum";

export type HistoryKind = "issued" | "revoked" | "batchIssued" | "batchLeafRevoked";

export type HistoryItem = {
  kind: HistoryKind;
  certHash?: string;
  merkleRoot?: string;
  count?: number;
  timestamp: number;
  txHash: string;
  blockNumber: number;
  logIndex: number;
};

/** Some public nodes are pruned and intermittently refuse old logs, hence the fallbacks. */
const LOG_RPCS = ["https://sepolia.gateway.tenderly.co", PUBLIC_SEPOLIA_RPC];
const ATTEMPTS_PER_RPC = 2;

const iface = new Interface(CertificateRegistryAbi);
const EVENT_TOPICS = [
  "CertificateIssued",
  "CertificateRevoked",
  "BatchIssued",
  "BatchLeafRevoked",
].map((name) => iface.getEvent(name)!.topicHash);

const LABELS_KEY = "diplomachain.labels";

function readLabels(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LABELS_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/** Remember a human-readable name (e.g. PDF file name) for a hash, in this browser only. */
export function rememberLabel(hash: string, label: string) {
  const labels = readLabels();
  labels[hash.toLowerCase()] = label;
  localStorage.setItem(LABELS_KEY, JSON.stringify(labels));
}

export function labelFor(hash: string | undefined): string | null {
  if (!hash) return null;
  return readLabels()[hash.toLowerCase()] ?? null;
}

async function queryIssuerEvents(provider: Provider, issuer: string): Promise<HistoryItem[]> {
  const logs = await provider.getLogs({
    address: REGISTRY_ADDRESS,
    fromBlock: DEPLOY_BLOCK,
    toBlock: "latest",
    topics: [EVENT_TOPICS],
  });

  const items: HistoryItem[] = [];
  for (const log of logs) {
    const parsed = iface.parseLog(log);
    if (!parsed || (parsed.args.issuer as string).toLowerCase() !== issuer.toLowerCase()) continue;

    const base = { txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.index };
    const a = parsed.args;
    switch (parsed.name) {
      case "CertificateIssued":
        items.push({ ...base, kind: "issued", certHash: a.certHash, timestamp: Number(a.issuedAt) });
        break;
      case "CertificateRevoked":
        items.push({ ...base, kind: "revoked", certHash: a.certHash, timestamp: Number(a.revokedAt) });
        break;
      case "BatchIssued":
        items.push({
          ...base,
          kind: "batchIssued",
          merkleRoot: a.merkleRoot,
          count: Number(a.count),
          timestamp: Number(a.issuedAt),
        });
        break;
      case "BatchLeafRevoked":
        items.push({
          ...base,
          kind: "batchLeafRevoked",
          merkleRoot: a.merkleRoot,
          certHash: a.certHash,
          timestamp: Number(a.revokedAt),
        });
        break;
    }
  }
  return items.sort((x, y) => y.blockNumber - x.blockNumber || y.logIndex - x.logIndex);
}

/** All registry events emitted for `issuer`, newest first. */
export async function fetchIssuerHistory(issuer: string): Promise<HistoryItem[]> {
  const providers: Provider[] = LOG_RPCS.map(
    (url) => new JsonRpcProvider(url, Number(SEPOLIA_CHAIN_ID), { staticNetwork: true })
  );
  if (window.ethereum) providers.push(new BrowserProvider(window.ethereum));

  let lastError: unknown;
  for (const provider of providers) {
    for (let attempt = 0; attempt < ATTEMPTS_PER_RPC; attempt++) {
      try {
        return await queryIssuerEvents(provider, issuer);
      } catch (err) {
        lastError = err;
      }
    }
  }
  throw lastError;
}
