import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

// Real IssuerManager + CertificateRegistry, no mock.
const Status = { None: 0n, Valid: 1n, Revoked: 2n } as const;

const hashOf = (label: string) => ethers.keccak256(ethers.toUtf8Bytes(label));
const HASH = hashOf("diploma-alice.pdf");
const NEW_HASH = hashOf("diploma-new-university.pdf");

async function integrationFixture() {
  const [esprit, partner, newUni, stranger] = await ethers.getSigners();
  const manager = await ethers.deployContract("IssuerManager", [
    [esprit.address, partner.address],
    ["ESPRIT", "Partner University"],
  ]);
  const registry = await ethers.deployContract("CertificateRegistry", [await manager.getAddress()]);
  return { manager, registry, esprit, partner, newUni, stranger };
}

/** newUni applied and was admitted by both founders. */
async function admittedFixture() {
  const base = await integrationFixture();
  await base.manager.connect(base.newUni).applyToJoin("New University");
  await base.manager.connect(base.esprit).vote(1n, true);
  await base.manager.connect(base.partner).vote(1n, true);
  return base;
}

describe("Integration: IssuerManager + CertificateRegistry", () => {
  it("lets a founding member issue a certificate", async () => {
    const { registry, esprit } = await loadFixture(integrationFixture);
    await registry.connect(esprit).issueCertificate(HASH);

    const result = await registry.verifyCertificate(HASH);
    expect(result.status).to.equal(Status.Valid);
    expect(result.issuer).to.equal(esprit.address);
    expect(result.issuerApproved).to.equal(true);
  });

  it("blocks an applicant until the members admit it", async () => {
    const { manager, registry, esprit, partner, newUni } = await loadFixture(integrationFixture);
    await manager.connect(newUni).applyToJoin("New University");

    await expect(registry.connect(newUni).issueCertificate(NEW_HASH))
      .to.be.revertedWithCustomError(registry, "NotApprovedIssuer")
      .withArgs(newUni.address);

    await manager.connect(esprit).vote(1n, true);
    await manager.connect(partner).vote(1n, true);

    await registry.connect(newUni).issueCertificate(NEW_HASH);
    expect(await registry.isValid(NEW_HASH)).to.equal(true);
  });

  it("never lets a stranger issue", async () => {
    const { registry, stranger } = await loadFixture(integrationFixture);
    await expect(registry.connect(stranger).issueCertificate(HASH))
      .to.be.revertedWithCustomError(registry, "NotApprovedIssuer")
      .withArgs(stranger.address);
  });

  it("after a removal vote: no new certificates, old ones stay valid with issuerApproved=false", async () => {
    const { manager, registry, esprit, partner, newUni } = await loadFixture(admittedFixture);
    await registry.connect(newUni).issueCertificate(NEW_HASH);

    await manager.connect(esprit).proposeRemoval(newUni.address);
    await manager.connect(esprit).vote(2n, true);
    await manager.connect(partner).vote(2n, true);

    await expect(registry.connect(newUni).issueCertificate(HASH))
      .to.be.revertedWithCustomError(registry, "NotApprovedIssuer")
      .withArgs(newUni.address);

    expect(await registry.isValid(NEW_HASH)).to.equal(true);
    const result = await registry.verifyCertificate(NEW_HASH);
    expect(result.status).to.equal(Status.Valid);
    expect(result.issuerApproved).to.equal(false);
  });

  it("a removed institution can still revoke its own certificates", async () => {
    const { manager, registry, esprit, partner, newUni } = await loadFixture(admittedFixture);
    await registry.connect(newUni).issueCertificate(NEW_HASH);
    await manager.connect(esprit).proposeRemoval(newUni.address);
    await manager.connect(esprit).vote(2n, true);
    await manager.connect(partner).vote(2n, true);

    await registry.connect(newUni).revokeCertificate(NEW_HASH);
    expect((await registry.verifyCertificate(NEW_HASH)).status).to.equal(Status.Revoked);
  });

  it("an institution that leaves behaves like a removed one", async () => {
    const { manager, registry, esprit } = await loadFixture(integrationFixture);
    await registry.connect(esprit).issueCertificate(HASH);
    await manager.connect(esprit).leave();

    await expect(registry.connect(esprit).issueCertificate(NEW_HASH)).to.be.revertedWithCustomError(
      registry,
      "NotApprovedIssuer"
    );
    const result = await registry.verifyCertificate(HASH);
    expect(result.status).to.equal(Status.Valid);
    expect(result.issuerApproved).to.equal(false);
  });

  it("re-admission restores issuerApproved on old certificates", async () => {
    const { manager, registry, esprit, partner, newUni } = await loadFixture(admittedFixture);
    await registry.connect(newUni).issueCertificate(NEW_HASH);
    await manager.connect(newUni).leave();
    expect((await registry.verifyCertificate(NEW_HASH)).issuerApproved).to.equal(false);

    await manager.connect(newUni).applyToJoin("New University");
    await manager.connect(esprit).vote(2n, true);
    await manager.connect(partner).vote(2n, true);
    expect((await registry.verifyCertificate(NEW_HASH)).issuerApproved).to.equal(true);
  });

  it("Merkle batches follow the same membership rules", async () => {
    const { manager, registry, esprit, partner, newUni } = await loadFixture(admittedFixture);
    const tree = StandardMerkleTree.of([[HASH], [NEW_HASH]], ["bytes32"]);

    await registry.connect(newUni).issueBatch(tree.root, 2);
    await manager.connect(esprit).proposeRemoval(newUni.address);
    await manager.connect(esprit).vote(2n, true);
    await manager.connect(partner).vote(2n, true);

    const proof = tree.getProof([HASH]);
    const result = await registry.verifyInBatch(tree.root, HASH, proof);
    expect(result.valid).to.equal(true);
    expect(result.issuerApproved).to.equal(false);

    const other = StandardMerkleTree.of([[hashOf("x")], [hashOf("y")]], ["bytes32"]);
    await expect(registry.connect(newUni).issueBatch(other.root, 2)).to.be.revertedWithCustomError(
      registry,
      "NotApprovedIssuer"
    );
  });
});
