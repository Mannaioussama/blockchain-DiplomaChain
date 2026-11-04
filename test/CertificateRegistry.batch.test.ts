import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { CertificateRegistry } from "../typechain-types";

const hashOf = (label: string) => ethers.keccak256(ethers.toUtf8Bytes(label));

const HASH_A = hashOf("batch-diploma-a.pdf");
const HASH_B = hashOf("batch-diploma-b.pdf");
const HASH_C = hashOf("batch-diploma-c.pdf");
const HASH_OUTSIDER = hashOf("not-in-batch.pdf");

async function fixNextTimestamp(offset = 100): Promise<number> {
  const timestamp = (await time.latest()) + offset;
  await time.setNextBlockTimestamp(timestamp);
  return timestamp;
}

function buildTree(hashes: string[]) {
  const values = hashes.map((h) => [h] as [string]);
  return StandardMerkleTree.of(values, ["bytes32"]);
}

function proofFor(tree: StandardMerkleTree<[string]>, certHash: string): string[] {
  for (const [i, v] of tree.entries()) {
    if (v[0] === certHash) {
      return tree.getProof(i);
    }
  }
  throw new Error(`hash not in tree: ${certHash}`);
}

async function deployFixture() {
  const [, issuerA, issuerB, stranger] = await ethers.getSigners();

  const manager = await ethers.deployContract("MockIssuerManager");
  await manager.setApproved(issuerA.address, true);
  await manager.setApproved(issuerB.address, true);

  const registry = (await ethers.deployContract("CertificateRegistry", [
    await manager.getAddress(),
  ])) as unknown as CertificateRegistry;

  const tree = buildTree([HASH_A, HASH_B, HASH_C]);
  const root = tree.root;

  return { registry, manager, issuerA, issuerB, stranger, tree, root };
}

async function issuedBatchFixture() {
  const base = await deployFixture();
  await base.registry.connect(base.issuerA).issueBatch(base.root, 3);
  return base;
}

describe("CertificateRegistry Merkle batches", () => {
  describe("issueBatch", () => {
    it("lets an approved issuer issue a batch root", async () => {
      const { registry, issuerA, root } = await loadFixture(deployFixture);

      const timestamp = await fixNextTimestamp();
      await registry.connect(issuerA).issueBatch(root, 3);

      const batch = await registry.getBatch(root);
      expect(batch.exists).to.equal(true);
      expect(batch.issuer).to.equal(issuerA.address);
      expect(batch.issuedAt).to.equal(timestamp);
      expect(batch.count).to.equal(3);
    });

    it("emits BatchIssued", async () => {
      const { registry, issuerA, root } = await loadFixture(deployFixture);
      const timestamp = await fixNextTimestamp();

      await expect(registry.connect(issuerA).issueBatch(root, 3))
        .to.emit(registry, "BatchIssued")
        .withArgs(root, issuerA.address, 3, timestamp);
    });

    it("reverts with NotApprovedIssuer for a stranger", async () => {
      const { registry, stranger, root } = await loadFixture(deployFixture);
      await expect(registry.connect(stranger).issueBatch(root, 3))
        .to.be.revertedWithCustomError(registry, "NotApprovedIssuer")
        .withArgs(stranger.address);
    });

    it("reverts with InvalidHash for the zero root", async () => {
      const { registry, issuerA } = await loadFixture(deployFixture);
      await expect(registry.connect(issuerA).issueBatch(ethers.ZeroHash, 1)).to.be.revertedWithCustomError(
        registry,
        "InvalidHash"
      );
    });

    it("reverts with BatchAlreadyExists when the same root is issued twice", async () => {
      const { registry, issuerA, issuerB, root } = await loadFixture(deployFixture);
      await registry.connect(issuerA).issueBatch(root, 3);
      await expect(registry.connect(issuerB).issueBatch(root, 99))
        .to.be.revertedWithCustomError(registry, "BatchAlreadyExists")
        .withArgs(root);
    });

    it("stores count as informational only (zero count is allowed)", async () => {
      const { registry, issuerA, root } = await loadFixture(deployFixture);
      await registry.connect(issuerA).issueBatch(root, 0);
      expect((await registry.getBatch(root)).count).to.equal(0);
    });
  });

  describe("verifyInBatch", () => {
    it("returns valid=true for a proof in an issued batch", async () => {
      const { registry, issuerA, tree, root } = await loadFixture(issuedBatchFixture);
      const proof = proofFor(tree, HASH_A);

      const result = await registry.verifyInBatch(root, HASH_A, proof);
      expect(result.valid).to.equal(true);
      expect(result.issuer).to.equal(issuerA.address);
      expect(result.revoked).to.equal(false);
      expect(result.issuerApproved).to.equal(true);
      expect(result.issuedAt).to.be.gt(0n);
    });

    it("returns valid=false for a hash not in the tree", async () => {
      const { registry, tree, root } = await loadFixture(issuedBatchFixture);
      // Reuse a real proof shape but for a foreign hash — proof will not match.
      const proof = proofFor(tree, HASH_A);
      const result = await registry.verifyInBatch(root, HASH_OUTSIDER, proof);
      expect(result.valid).to.equal(false);
      expect(result.revoked).to.equal(false);
    });

    it("returns empty data for an unknown root", async () => {
      const { registry, tree } = await loadFixture(deployFixture);
      const proof = proofFor(tree, HASH_A);
      const result = await registry.verifyInBatch(tree.root, HASH_A, proof);
      expect(result.valid).to.equal(false);
      expect(result.issuer).to.equal(ethers.ZeroAddress);
      expect(result.issuedAt).to.equal(0n);
      expect(result.issuerApproved).to.equal(false);
    });

    it("keeps valid=true when the issuer is removed, but issuerApproved=false", async () => {
      const { registry, manager, issuerA, tree, root } = await loadFixture(issuedBatchFixture);
      await manager.setApproved(issuerA.address, false);

      const proof = proofFor(tree, HASH_B);
      const result = await registry.verifyInBatch(root, HASH_B, proof);
      expect(result.valid).to.equal(true);
      expect(result.issuerApproved).to.equal(false);
    });

    it("does not make isValid() true for a batch leaf (separate namespace)", async () => {
      const { registry, tree, root } = await loadFixture(issuedBatchFixture);
      const proof = proofFor(tree, HASH_A);
      expect((await registry.verifyInBatch(root, HASH_A, proof)).valid).to.equal(true);
      expect(await registry.isValid(HASH_A)).to.equal(false);
    });

    it("returns valid=false when the proof is longer than MAX_PROOF_LENGTH", async () => {
      const { registry, root } = await loadFixture(issuedBatchFixture);
      const tooLong = Array.from({ length: 33 }, () => ethers.id("x"));
      const result = await registry.verifyInBatch(root, HASH_A, tooLong);
      expect(result.valid).to.equal(false);
    });

    it("returns valid=false for the zero cert hash on an existing batch", async () => {
      const { registry, issuerA, root } = await loadFixture(issuedBatchFixture);
      const result = await registry.verifyInBatch(root, ethers.ZeroHash, []);
      expect(result.valid).to.equal(false);
      expect(result.issuer).to.equal(issuerA.address);
      expect(result.issuerApproved).to.equal(true);
    });
  });

  describe("revokeBatchLeaf", () => {
    it("lets the batch issuer revoke a leaf with a valid proof", async () => {
      const { registry, issuerA, tree, root } = await loadFixture(issuedBatchFixture);
      const proof = proofFor(tree, HASH_A);
      const timestamp = await fixNextTimestamp();

      await expect(registry.connect(issuerA).revokeBatchLeaf(root, HASH_A, proof))
        .to.emit(registry, "BatchLeafRevoked")
        .withArgs(root, HASH_A, issuerA.address, timestamp);

      expect(await registry.isBatchLeafRevoked(root, HASH_A)).to.equal(true);
      const result = await registry.verifyInBatch(root, HASH_A, proof);
      expect(result.valid).to.equal(false);
      expect(result.revoked).to.equal(true);
    });

    it("only revokes the targeted leaf", async () => {
      const { registry, issuerA, tree, root } = await loadFixture(issuedBatchFixture);
      await registry.connect(issuerA).revokeBatchLeaf(root, HASH_A, proofFor(tree, HASH_A));

      expect((await registry.verifyInBatch(root, HASH_B, proofFor(tree, HASH_B))).valid).to.equal(true);
      expect((await registry.verifyInBatch(root, HASH_C, proofFor(tree, HASH_C))).valid).to.equal(true);
    });

    it("still lets a removed issuer revoke its own batch leaf", async () => {
      const { registry, manager, issuerA, tree, root } = await loadFixture(issuedBatchFixture);
      await manager.setApproved(issuerA.address, false);

      await registry.connect(issuerA).revokeBatchLeaf(root, HASH_C, proofFor(tree, HASH_C));
      expect(await registry.isBatchLeafRevoked(root, HASH_C)).to.equal(true);
    });

    it("reverts with NotBatchIssuer when another approved issuer tries to revoke", async () => {
      const { registry, issuerA, issuerB, tree, root } = await loadFixture(issuedBatchFixture);
      await expect(
        registry.connect(issuerB).revokeBatchLeaf(root, HASH_A, proofFor(tree, HASH_A))
      )
        .to.be.revertedWithCustomError(registry, "NotBatchIssuer")
        .withArgs(issuerB.address, issuerA.address);
    });

    it("reverts with BatchNotFound for an unknown root", async () => {
      const { registry, issuerA, tree } = await loadFixture(deployFixture);
      await expect(
        registry.connect(issuerA).revokeBatchLeaf(tree.root, HASH_A, proofFor(tree, HASH_A))
      )
        .to.be.revertedWithCustomError(registry, "BatchNotFound")
        .withArgs(tree.root);
    });

    it("reverts with InvalidProof for a garbage leaf / bad proof", async () => {
      const { registry, issuerA, tree, root } = await loadFixture(issuedBatchFixture);
      await expect(
        registry.connect(issuerA).revokeBatchLeaf(root, HASH_OUTSIDER, proofFor(tree, HASH_A))
      ).to.be.revertedWithCustomError(registry, "InvalidProof");
    });

    it("reverts with LeafAlreadyRevoked when revoking twice", async () => {
      const { registry, issuerA, tree, root } = await loadFixture(issuedBatchFixture);
      const proof = proofFor(tree, HASH_A);
      await registry.connect(issuerA).revokeBatchLeaf(root, HASH_A, proof);
      await expect(registry.connect(issuerA).revokeBatchLeaf(root, HASH_A, proof))
        .to.be.revertedWithCustomError(registry, "LeafAlreadyRevoked")
        .withArgs(root, HASH_A);
    });

    it("reverts with InvalidHash for the zero cert hash", async () => {
      const { registry, issuerA, tree, root } = await loadFixture(issuedBatchFixture);
      await expect(
        registry.connect(issuerA).revokeBatchLeaf(root, ethers.ZeroHash, proofFor(tree, HASH_A))
      ).to.be.revertedWithCustomError(registry, "InvalidHash");
    });

    it("reverts with ProofTooLong when the proof exceeds MAX_PROOF_LENGTH", async () => {
      const { registry, issuerA, root } = await loadFixture(issuedBatchFixture);
      const tooLong = Array.from({ length: 33 }, () => ethers.id("pad"));
      await expect(registry.connect(issuerA).revokeBatchLeaf(root, HASH_A, tooLong))
        .to.be.revertedWithCustomError(registry, "ProofTooLong")
        .withArgs(33);
    });
  });
});
