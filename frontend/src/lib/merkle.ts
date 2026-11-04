import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { normalizeHash } from "./ethereum";

export type BatchEntry = {
  label: string;
  certHash: string;
};

export type BatchProofBundle = {
  merkleRoot: string;
  count: number;
  leafEncoding: ["bytes32"];
  createdAt: string;
  entries: Array<{
    label: string;
    certHash: string;
    proof: string[];
  }>;
};

/** Build an OpenZeppelin StandardMerkleTree over diploma hashes (bytes32). */
export function buildBatchTree(entries: BatchEntry[]) {
  if (entries.length === 0) {
    throw new Error("Add at least one diploma hash to build a batch.");
  }
  const normalized = entries.map((e) => ({
    label: e.label,
    certHash: normalizeHash(e.certHash),
  }));
  const values = normalized.map((e) => [e.certHash] as [string]);
  const tree = StandardMerkleTree.of(values, ["bytes32"]);
  return { tree, entries: normalized, root: tree.root };
}

export function proofsForTree(
  tree: StandardMerkleTree<[string]>,
  entries: BatchEntry[]
): BatchProofBundle["entries"] {
  return entries.map((e) => {
    let proof: string[] | undefined;
    for (const [i, v] of tree.entries()) {
      if (v[0].toLowerCase() === e.certHash.toLowerCase()) {
        proof = tree.getProof(i);
        break;
      }
    }
    if (!proof) {
      throw new Error(`Hash not found in tree: ${e.certHash}`);
    }
    return { label: e.label, certHash: e.certHash, proof };
  });
}

export function makeProofBundle(
  root: string,
  entries: BatchProofBundle["entries"]
): BatchProofBundle {
  return {
    merkleRoot: root,
    count: entries.length,
    leafEncoding: ["bytes32"],
    createdAt: new Date().toISOString(),
    entries,
  };
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Parse a proof from JSON array text or a full proof-bundle entry. */
export function parseProofInput(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Paste a Merkle proof (JSON array of 0x… hashes).");
  const parsed = JSON.parse(trimmed) as unknown;
  if (Array.isArray(parsed)) {
    return parsed.map((p) => {
      if (typeof p !== "string") throw new Error("Proof must be an array of hex strings.");
      return normalizeHash(p);
    });
  }
  if (parsed && typeof parsed === "object" && "proof" in parsed) {
    const proof = (parsed as { proof: unknown }).proof;
    if (!Array.isArray(proof)) throw new Error("Invalid proof object.");
    return proof.map((p) => normalizeHash(String(p)));
  }
  throw new Error("Proof must be a JSON array like [\"0x…\", \"0x…\"].");
}
