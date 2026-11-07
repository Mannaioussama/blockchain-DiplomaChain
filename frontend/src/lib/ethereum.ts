import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  Interface,
  keccak256,
  isHexString,
  getAddress,
  type Eip1193Provider,
  type Signer,
  type Provider,
} from "ethers";
import CertificateRegistryAbi from "../contracts/CertificateRegistryAbi.json";
import IssuerManagerAbi from "../contracts/IssuerManagerAbi.json";
import deployment from "../contracts/sepolia.json";

export const SEPOLIA_CHAIN_ID = 11155111n;
export const SEPOLIA_CHAIN_ID_HEX = "0xaa36a7";

/** Public read-only RPC used when MetaMask is not available (Verifier page). */
export const PUBLIC_SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

export const REGISTRY_ADDRESS = getAddress(deployment.certificateRegistry);
export const ISSUER_MANAGER_ADDRESS = getAddress(deployment.issuerManager);
/** First block to scan for registry events (history). */
export const DEPLOY_BLOCK: number = deployment.deployBlock ?? 0;

export const ETHERSCAN_TX = (hash: string) =>
  `https://sepolia.etherscan.io/tx/${hash}`;
export const ETHERSCAN_ADDRESS = (addr: string) =>
  `https://sepolia.etherscan.io/address/${addr}`;

export type Status = 0 | 1 | 2; // None | Valid | Revoked

export const STATUS_LABEL: Record<Status, string> = {
  0: "Not found",
  1: "Valid",
  2: "Revoked",
};

/** Mirrors IssuerManager.InstitutionStatus. */
export type InstitutionStatus = 0 | 1 | 2 | 3 | 4 | 5;

export const INSTITUTION_STATUS_LABEL: Record<InstitutionStatus, string> = {
  0: "Not registered",
  1: "Application pending",
  2: "Member",
  3: "Application rejected",
  4: "Removed by vote",
  5: "Left the consortium",
};

export type Institution = {
  address: string;
  name: string;
  status: InstitutionStatus;
  updatedAt: number;
};

const registryIface = new Interface(CertificateRegistryAbi);
const managerIface = new Interface(IssuerManagerAbi);

const ERROR_MESSAGES: Record<string, string> = {
  NotApprovedIssuer:
    "Your wallet is not an approved issuer. Your institution must be admitted by the consortium first.",
  InvalidHash: "The certificate hash is invalid (cannot be the zero hash).",
  CertificateAlreadyExists:
    "A certificate with this hash already exists (or was revoked — re-issue is blocked).",
  CertificateNotFound: "No certificate found for this hash.",
  CertificateAlreadyRevoked: "This certificate is already revoked.",
  NotCertificateIssuer:
    "Only the original issuer of this certificate can revoke it.",
  InvalidIssuerManager: "IssuerManager address is invalid.",
  BatchAlreadyExists: "This Merkle root was already issued as a batch.",
  BatchNotFound: "No batch found for this Merkle root.",
  InvalidProof: "The Merkle proof is invalid for this root / hash.",
  LeafAlreadyRevoked: "This batch leaf was already revoked.",
  NotBatchIssuer: "Only the original batch issuer can revoke a leaf.",
  ProofTooLong: "Merkle proof is too long (max 32 nodes).",
  InvalidName: "The institution name must be between 1 and 64 characters.",
  NotMember: "This wallet is not a member of the consortium.",
  AlreadyMember: "This institution is already a member of the consortium.",
  OpenProposalExists: "There is already an open proposal about this institution.",
  NoOpenApplication: "You have no pending application to withdraw.",
  ProposalNotOpen: "This proposal is already closed.",
  AlreadyVoted: "You already voted on this proposal.",
  CannotVoteOnOwnRemoval: "You cannot vote on your own removal.",
  CannotProposeOwnRemoval: "Use “Leave the consortium” to remove your own institution.",
  LastMember: "The last member cannot leave the consortium.",
};

declare global {
  interface Window {
    ethereum?: Eip1193Provider & {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on?: (event: string, handler: (...args: unknown[]) => void) => void;
      removeListener?: (
        event: string,
        handler: (...args: unknown[]) => void
      ) => void;
    };
  }
}

export function hasMetaMask(): boolean {
  return typeof window !== "undefined" && !!window.ethereum;
}

export async function getBrowserProvider(): Promise<BrowserProvider> {
  if (!window.ethereum) {
    throw new Error("MetaMask is not installed.");
  }
  return new BrowserProvider(window.ethereum);
}

export async function connectWallet(): Promise<{
  provider: BrowserProvider;
  signer: Signer;
  address: string;
  chainId: bigint;
}> {
  const provider = await getBrowserProvider();
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const network = await provider.getNetwork();
  return {
    provider,
    signer,
    address: await signer.getAddress(),
    chainId: network.chainId,
  };
}

export async function ensureSepolia(provider: BrowserProvider): Promise<void> {
  const network = await provider.getNetwork();
  if (network.chainId === SEPOLIA_CHAIN_ID) return;

  try {
    await provider.send("wallet_switchEthereumChain", [
      { chainId: SEPOLIA_CHAIN_ID_HEX },
    ]);
  } catch (err: unknown) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code: number }).code
        : undefined;
    // 4902 = chain not added to MetaMask
    if (code === 4902) {
      await provider.send("wallet_addEthereumChain", [
        {
          chainId: SEPOLIA_CHAIN_ID_HEX,
          chainName: "Sepolia",
          nativeCurrency: { name: "SepoliaETH", symbol: "ETH", decimals: 18 },
          rpcUrls: [PUBLIC_SEPOLIA_RPC],
          blockExplorerUrls: ["https://sepolia.etherscan.io"],
        },
      ]);
      return;
    }
    throw err;
  }
}

/** Read-only provider: MetaMask if present, otherwise a public Sepolia RPC. */
export function getReadProvider(): Provider {
  if (window.ethereum) {
    return new BrowserProvider(window.ethereum);
  }
  return new JsonRpcProvider(PUBLIC_SEPOLIA_RPC);
}

export function getRegistry(runner: Signer | Provider): Contract {
  return new Contract(REGISTRY_ADDRESS, CertificateRegistryAbi, runner);
}

export function getIssuerManager(runner: Signer | Provider): Contract {
  return new Contract(ISSUER_MANAGER_ADDRESS, IssuerManagerAbi, runner);
}

export async function getInstitution(
  address: string,
  runner: Signer | Provider = getReadProvider()
): Promise<Institution> {
  const result = (await getIssuerManager(runner).getInstitution(address)) as {
    name: string;
    status: bigint;
    updatedAt: bigint;
  };
  return {
    address,
    name: result.name,
    status: Number(result.status) as InstitutionStatus,
    updatedAt: Number(result.updatedAt),
  };
}

export async function hashPdfFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return keccak256(bytes);
}

export function normalizeHash(input: string): string {
  const trimmed = input.trim();
  if (!isHexString(trimmed, 32)) {
    throw new Error("Hash must be a 32-byte hex string (0x + 64 hex chars).");
  }
  return trimmed.toLowerCase();
}

export function decodeContractError(err: unknown): string {
  // ethers v6 custom errors often land on err.data / err.info.error.data / nested cause
  const candidates: string[] = [];

  const walk = (value: unknown, depth = 0) => {
    if (!value || depth > 5) return;
    if (typeof value === "string") {
      if (value.startsWith("0x") && value.length >= 10) candidates.push(value);
      return;
    }
    if (typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (typeof obj.data === "string") candidates.push(obj.data);
    if (obj.data && typeof obj.data === "object") walk(obj.data, depth + 1);
    if (obj.info) walk(obj.info, depth + 1);
    if (obj.error) walk(obj.error, depth + 1);
    if (obj.cause) walk(obj.cause, depth + 1);
    if (typeof obj.message === "string") {
      const match = obj.message.match(/data="?(0x[0-9a-fA-F]+)"?/);
      if (match) candidates.push(match[1]);
    }
  };
  walk(err);

  for (const data of candidates) {
    for (const iface of [registryIface, managerIface]) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) {
          const human = ERROR_MESSAGES[parsed.name];
          return human ?? `${parsed.name}`;
        }
      } catch {
        // try next interface / candidate
      }
    }
  }

  if (err && typeof err === "object" && "code" in err && err.code === "ACTION_REJECTED") {
    return "Request rejected in MetaMask.";
  }

  if (err && typeof err === "object" && "shortMessage" in err) {
    return String((err as { shortMessage: string }).shortMessage);
  }
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: string }).message);
  }
  return "Transaction failed.";
}

export function formatTimestamp(value: bigint | number): string {
  const n = typeof value === "bigint" ? Number(value) : value;
  if (!n) return "—";
  return new Date(n * 1000).toLocaleString();
}

export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
