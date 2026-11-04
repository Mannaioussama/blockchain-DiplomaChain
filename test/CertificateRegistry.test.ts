import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

// Mirrors the Solidity enum: enum Status { None, Valid, Revoked }
const Status = { None: 0n, Valid: 1n, Revoked: 2n } as const;

const hashOf = (label: string) => ethers.keccak256(ethers.toUtf8Bytes(label));
const HASH = hashOf("diploma-alice.pdf");
const OTHER_HASH = hashOf("diploma-bob.pdf");

/** Forces the next block to a known timestamp so event arguments can be checked exactly. */
async function fixNextTimestamp(offset = 100): Promise<number> {
  const timestamp = (await time.latest()) + offset;
  await time.setNextBlockTimestamp(timestamp);
  return timestamp;
}

async function deployFixture() {
  const [, issuerA, issuerB, stranger] = await ethers.getSigners();

  const manager = await ethers.deployContract("MockIssuerManager");
  await manager.setApproved(issuerA.address, true);
  await manager.setApproved(issuerB.address, true);

  const registry = await ethers.deployContract("CertificateRegistry", [
    await manager.getAddress(),
  ]);

  return { registry, manager, issuerA, issuerB, stranger };
}

/** Same as deployFixture, but with a certificate already issued by issuerA. */
async function issuedFixture() {
  const base = await deployFixture();
  await base.registry.connect(base.issuerA).issueCertificate(HASH);
  return base;
}

describe("CertificateRegistry", () => {
  /* ------------------------------------------------------------------ */
  describe("deployment", () => {
    it("stores the IssuerManager address", async () => {
      const { registry, manager } = await loadFixture(deployFixture);
      expect(await registry.issuerManager()).to.equal(await manager.getAddress());
    });

    it("reverts when the IssuerManager is the zero address", async () => {
      const { registry } = await loadFixture(deployFixture);
      await expect(ethers.deployContract("CertificateRegistry", [ethers.ZeroAddress]))
        .to.be.revertedWithCustomError(registry, "InvalidIssuerManager")
        .withArgs(ethers.ZeroAddress);
    });

    it("reverts when the IssuerManager address is not a contract", async () => {
      const { registry, stranger } = await loadFixture(deployFixture);
      await expect(ethers.deployContract("CertificateRegistry", [stranger.address]))
        .to.be.revertedWithCustomError(registry, "InvalidIssuerManager")
        .withArgs(stranger.address);
    });
  });

  /* ------------------------------------------------------------------ */
  describe("issueCertificate", () => {
    it("lets an approved issuer issue a certificate", async () => {
      const { registry, issuerA } = await loadFixture(deployFixture);

      const timestamp = await fixNextTimestamp();
      await registry.connect(issuerA).issueCertificate(HASH);

      const result = await registry.verifyCertificate(HASH);
      expect(result.status).to.equal(Status.Valid);
      expect(result.issuer).to.equal(issuerA.address);
      expect(result.issuedAt).to.equal(timestamp);
      expect(result.revokedAt).to.equal(0n);
      expect(await registry.isValid(HASH)).to.equal(true);
    });

    it("emits CertificateIssued with the hash, the issuer and the timestamp", async () => {
      const { registry, issuerA } = await loadFixture(deployFixture);

      const timestamp = await fixNextTimestamp();
      await expect(registry.connect(issuerA).issueCertificate(HASH))
        .to.emit(registry, "CertificateIssued")
        .withArgs(HASH, issuerA.address, timestamp);
    });

    it("lets several approved issuers issue different certificates", async () => {
      const { registry, issuerA, issuerB } = await loadFixture(deployFixture);

      await registry.connect(issuerA).issueCertificate(HASH);
      await registry.connect(issuerB).issueCertificate(OTHER_HASH);

      expect((await registry.verifyCertificate(HASH)).issuer).to.equal(issuerA.address);
      expect((await registry.verifyCertificate(OTHER_HASH)).issuer).to.equal(issuerB.address);
    });

    it("reverts with NotApprovedIssuer when the caller was never approved", async () => {
      const { registry, stranger } = await loadFixture(deployFixture);

      await expect(registry.connect(stranger).issueCertificate(HASH))
        .to.be.revertedWithCustomError(registry, "NotApprovedIssuer")
        .withArgs(stranger.address);
      expect(await registry.isValid(HASH)).to.equal(false);
    });

    it("reverts with NotApprovedIssuer once the issuer has been removed", async () => {
      const { registry, manager, issuerA } = await loadFixture(deployFixture);

      await manager.setApproved(issuerA.address, false);

      await expect(registry.connect(issuerA).issueCertificate(HASH))
        .to.be.revertedWithCustomError(registry, "NotApprovedIssuer")
        .withArgs(issuerA.address);
    });

    it("reverts with InvalidHash for the zero hash", async () => {
      const { registry, issuerA } = await loadFixture(deployFixture);

      await expect(
        registry.connect(issuerA).issueCertificate(ethers.ZeroHash)
      ).to.be.revertedWithCustomError(registry, "InvalidHash");
    });

    it("reverts with CertificateAlreadyExists when the same issuer issues the same hash twice", async () => {
      const { registry, issuerA } = await loadFixture(issuedFixture);

      await expect(registry.connect(issuerA).issueCertificate(HASH))
        .to.be.revertedWithCustomError(registry, "CertificateAlreadyExists")
        .withArgs(HASH);
    });

    it("reverts with CertificateAlreadyExists when another approved issuer uses the same hash", async () => {
      const { registry, issuerA, issuerB } = await loadFixture(issuedFixture);

      await expect(registry.connect(issuerB).issueCertificate(HASH))
        .to.be.revertedWithCustomError(registry, "CertificateAlreadyExists")
        .withArgs(HASH);
      // The original certificate is untouched.
      expect((await registry.verifyCertificate(HASH)).issuer).to.equal(issuerA.address);
    });

    it("does not allow re-issuing a revoked hash", async () => {
      const { registry, issuerA } = await loadFixture(issuedFixture);
      await registry.connect(issuerA).revokeCertificate(HASH);

      await expect(registry.connect(issuerA).issueCertificate(HASH))
        .to.be.revertedWithCustomError(registry, "CertificateAlreadyExists")
        .withArgs(HASH);
      expect(await registry.isValid(HASH)).to.equal(false);
    });
  });

  /* ------------------------------------------------------------------ */
  describe("revokeCertificate", () => {
    it("lets the original issuer revoke its certificate", async () => {
      const { registry, issuerA } = await loadFixture(issuedFixture);
      const before = await registry.verifyCertificate(HASH);

      const timestamp = await fixNextTimestamp();
      await registry.connect(issuerA).revokeCertificate(HASH);

      const after = await registry.verifyCertificate(HASH);
      expect(after.status).to.equal(Status.Revoked);
      expect(after.revokedAt).to.equal(timestamp);
      // Issuer and issuance date are preserved.
      expect(after.issuer).to.equal(issuerA.address);
      expect(after.issuedAt).to.equal(before.issuedAt);
      expect(await registry.isValid(HASH)).to.equal(false);
    });

    it("emits CertificateRevoked with the hash, the issuer and the timestamp", async () => {
      const { registry, issuerA } = await loadFixture(issuedFixture);

      const timestamp = await fixNextTimestamp();
      await expect(registry.connect(issuerA).revokeCertificate(HASH))
        .to.emit(registry, "CertificateRevoked")
        .withArgs(HASH, issuerA.address, timestamp);
    });

    it("only revokes the targeted certificate", async () => {
      const { registry, issuerA } = await loadFixture(issuedFixture);
      await registry.connect(issuerA).issueCertificate(OTHER_HASH);

      await registry.connect(issuerA).revokeCertificate(HASH);

      expect(await registry.isValid(HASH)).to.equal(false);
      expect(await registry.isValid(OTHER_HASH)).to.equal(true);
    });

    it("reverts with NotCertificateIssuer when another approved issuer tries to revoke", async () => {
      const { registry, issuerA, issuerB } = await loadFixture(issuedFixture);

      await expect(registry.connect(issuerB).revokeCertificate(HASH))
        .to.be.revertedWithCustomError(registry, "NotCertificateIssuer")
        .withArgs(issuerB.address, issuerA.address);
      expect(await registry.isValid(HASH)).to.equal(true);
    });

    it("reverts with NotCertificateIssuer when a stranger tries to revoke", async () => {
      const { registry, issuerA, stranger } = await loadFixture(issuedFixture);

      await expect(registry.connect(stranger).revokeCertificate(HASH))
        .to.be.revertedWithCustomError(registry, "NotCertificateIssuer")
        .withArgs(stranger.address, issuerA.address);
      expect(await registry.isValid(HASH)).to.equal(true);
    });

    it("reverts with CertificateNotFound for an unknown hash", async () => {
      const { registry, issuerA } = await loadFixture(deployFixture);

      await expect(registry.connect(issuerA).revokeCertificate(HASH))
        .to.be.revertedWithCustomError(registry, "CertificateNotFound")
        .withArgs(HASH);
    });

    it("reverts with CertificateAlreadyRevoked when revoking twice", async () => {
      const { registry, issuerA } = await loadFixture(issuedFixture);
      await registry.connect(issuerA).revokeCertificate(HASH);
      const firstRevocation = (await registry.verifyCertificate(HASH)).revokedAt;

      await expect(registry.connect(issuerA).revokeCertificate(HASH))
        .to.be.revertedWithCustomError(registry, "CertificateAlreadyRevoked")
        .withArgs(HASH);
      // The original revocation timestamp is not overwritten.
      expect((await registry.verifyCertificate(HASH)).revokedAt).to.equal(firstRevocation);
    });

    it("still lets a removed issuer revoke its own certificate", async () => {
      const { registry, manager, issuerA } = await loadFixture(issuedFixture);
      await manager.setApproved(issuerA.address, false);

      await expect(registry.connect(issuerA).revokeCertificate(HASH))
        .to.emit(registry, "CertificateRevoked");
      expect(await registry.isValid(HASH)).to.equal(false);
    });
  });

  /* ------------------------------------------------------------------ */
  describe("isValid and verifyCertificate", () => {
    it("reports an unknown hash as not valid, with empty data", async () => {
      const { registry } = await loadFixture(deployFixture);

      expect(await registry.isValid(HASH)).to.equal(false);

      const result = await registry.verifyCertificate(HASH);
      expect(result.status).to.equal(Status.None);
      expect(result.issuer).to.equal(ethers.ZeroAddress);
      expect(result.issuedAt).to.equal(0n);
      expect(result.revokedAt).to.equal(0n);
      expect(result.issuerApproved).to.equal(false);
    });

    it("reports a freshly issued certificate as valid and its issuer as approved", async () => {
      const { registry, issuerA } = await loadFixture(issuedFixture);

      expect(await registry.isValid(HASH)).to.equal(true);

      const result = await registry.verifyCertificate(HASH);
      expect(result.status).to.equal(Status.Valid);
      expect(result.issuer).to.equal(issuerA.address);
      expect(result.issuerApproved).to.equal(true);
    });

    it("reports a revoked certificate as not valid, with its revocation date", async () => {
      const { registry, issuerA } = await loadFixture(issuedFixture);
      await registry.connect(issuerA).revokeCertificate(HASH);

      expect(await registry.isValid(HASH)).to.equal(false);

      const result = await registry.verifyCertificate(HASH);
      expect(result.status).to.equal(Status.Revoked);
      expect(result.revokedAt).to.be.greaterThan(0n);
      expect(result.issuerApproved).to.equal(true);
    });

    it("keeps a certificate valid when its issuer is removed, but flags issuerApproved = false", async () => {
      const { registry, manager, issuerA } = await loadFixture(issuedFixture);

      await manager.setApproved(issuerA.address, false);

      // Agreed rule: removing an issuer does not invalidate what it already issued...
      expect(await registry.isValid(HASH)).to.equal(true);
      const result = await registry.verifyCertificate(HASH);
      expect(result.status).to.equal(Status.Valid);
      expect(result.issuer).to.equal(issuerA.address);
      // ...but the verifier can see that the institution is no longer accredited.
      expect(result.issuerApproved).to.equal(false);
    });

    it("flips issuerApproved back to true when the issuer is approved again", async () => {
      const { registry, manager, issuerA } = await loadFixture(issuedFixture);

      await manager.setApproved(issuerA.address, false);
      expect((await registry.verifyCertificate(HASH)).issuerApproved).to.equal(false);

      await manager.setApproved(issuerA.address, true);
      expect((await registry.verifyCertificate(HASH)).issuerApproved).to.equal(true);
    });

    it("reports a revoked certificate of a removed issuer as Revoked and not approved", async () => {
      const { registry, manager, issuerA } = await loadFixture(issuedFixture);
      await registry.connect(issuerA).revokeCertificate(HASH);
      await manager.setApproved(issuerA.address, false);

      const result = await registry.verifyCertificate(HASH);
      expect(result.status).to.equal(Status.Revoked);
      expect(result.issuerApproved).to.equal(false);
      expect(await registry.isValid(HASH)).to.equal(false);
    });

    it("only affects the certificates of the removed issuer", async () => {
      const { registry, manager, issuerA, issuerB } = await loadFixture(issuedFixture);
      await registry.connect(issuerB).issueCertificate(OTHER_HASH);

      await manager.setApproved(issuerA.address, false);

      expect((await registry.verifyCertificate(HASH)).issuerApproved).to.equal(false);
      expect((await registry.verifyCertificate(OTHER_HASH)).issuerApproved).to.equal(true);
    });
  });

  /* ------------------------------------------------------------------ */
  describe("when the IssuerManager misbehaves", () => {
    async function brokenManagerFixture() {
      const [, issuer] = await ethers.getSigners();
      const manager = await ethers.deployContract("MockRevertingIssuerManager");
      await manager.setApproved(issuer.address, true);
      const registry = await ethers.deployContract("CertificateRegistry", [
        await manager.getAddress(),
      ]);
      await registry.connect(issuer).issueCertificate(HASH);
      return { registry, manager, issuer };
    }

    it("verifyCertificate does not revert and reports issuerApproved = false", async () => {
      const { registry, manager } = await loadFixture(brokenManagerFixture);

      await manager.setOffline(true);

      expect(await registry.isValid(HASH)).to.equal(true);
      const result = await registry.verifyCertificate(HASH);
      expect(result.status).to.equal(Status.Valid);
      expect(result.issuerApproved).to.equal(false);
    });

    it("issuing fails closed (reverts) instead of letting anyone issue", async () => {
      const { registry, manager, issuer } = await loadFixture(brokenManagerFixture);

      await manager.setOffline(true);

      await expect(
        registry.connect(issuer).issueCertificate(OTHER_HASH)
      ).to.be.revertedWithCustomError(manager, "ManagerOffline");
      expect(await registry.isValid(OTHER_HASH)).to.equal(false);
    });
  });
});
