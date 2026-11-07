import { BrowserProvider, getAddress, hexlify, randomBytes, verifyMessage } from "ethers";
import { ensureSepolia, hasMetaMask, SEPOLIA_CHAIN_ID } from "./ethereum";

/** Signed-in wallet. The signature proves ownership; roles are read on-chain, never from here. */
export type Session = {
  address: string;
  signedAt: string;
};

const SESSION_KEY = "diplomachain.session";

/** EIP-4361 (Sign-In with Ethereum) style message. Signing it is free and sends no transaction. */
function buildSignInMessage(address: string, nonce: string, issuedAt: string): string {
  const { host, origin } = window.location;
  return [
    `${host} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in to DiplomaChain. This request will not trigger a blockchain transaction or cost any gas.",
    "",
    `URI: ${origin}`,
    "Version: 1",
    `Chain ID: ${SEPOLIA_CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

export async function signIn(): Promise<Session> {
  if (!hasMetaMask()) {
    throw new Error("MetaMask is required to sign in. Use Chrome with the MetaMask extension.");
  }
  await new BrowserProvider(window.ethereum!).send("eth_requestAccounts", []);
  await ensureSepolia(new BrowserProvider(window.ethereum!));

  // Fresh provider: the previous one may still point at the old network.
  const signer = await new BrowserProvider(window.ethereum!).getSigner();
  const address = getAddress(await signer.getAddress());
  const issuedAt = new Date().toISOString();
  const message = buildSignInMessage(address, hexlify(randomBytes(16)).slice(2), issuedAt);

  const signature = await signer.signMessage(message);
  if (getAddress(verifyMessage(message, signature)) !== address) {
    throw new Error("Signature does not match the connected wallet.");
  }

  const session: Session = { address, signedAt: issuedAt };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function signOut() {
  sessionStorage.removeItem(SESSION_KEY);
}

/** Current MetaMask account without opening a popup, or null. */
export async function currentAccount(): Promise<string | null> {
  if (!hasMetaMask()) return null;
  const accounts = (await window.ethereum!.request({ method: "eth_accounts" })) as string[];
  return accounts.length ? getAddress(accounts[0]) : null;
}
