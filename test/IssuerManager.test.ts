import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

// Mirror the Solidity enums.
const Inst = { None: 0n, Pending: 1n, Approved: 2n, Rejected: 3n, Removed: 4n, Left: 5n } as const;
const Kind = { Admission: 0n, Removal: 1n } as const;
const Prop = { None: 0n, Open: 1n, Approved: 2n, Rejected: 3n, Cancelled: 4n } as const;

async function fixNextTimestamp(offset = 100): Promise<number> {
  const timestamp = (await time.latest()) + offset;
  await time.setNextBlockTimestamp(timestamp);
  return timestamp;
}

/** Two founders, like the Sepolia demo. */
async function twoFoundersFixture() {
  const [a, b, applicant, stranger] = await ethers.getSigners();
  const manager = await ethers.deployContract("IssuerManager", [
    [a.address, b.address],
    ["ESPRIT", "Partner University"],
  ]);
  return { manager, a, b, applicant, stranger };
}

/** Three founders, so removals need a real majority of the others. */
async function threeFoundersFixture() {
  const [a, b, c, applicant, stranger] = await ethers.getSigners();
  const manager = await ethers.deployContract("IssuerManager", [
    [a.address, b.address, c.address],
    ["ESPRIT", "Partner University", "Third University"],
  ]);
  return { manager, a, b, c, applicant, stranger };
}

/** Two founders + an open application (proposal 1). */
async function applicationFixture() {
  const base = await twoFoundersFixture();
  await base.manager.connect(base.applicant).applyToJoin("New University");
  return base;
}

describe("IssuerManager", () => {
  /* ------------------------------------------------------------------ */
  describe("deployment", () => {
    it("registers the founders as approved members with their names", async () => {
      const { manager, a, b } = await loadFixture(twoFoundersFixture);

      expect(await manager.memberCount()).to.equal(2n);
      expect(await manager.getMembers()).to.deep.equal([a.address, b.address]);
      expect(await manager.isApprovedIssuer(a.address)).to.equal(true);
      expect(await manager.isApprovedIssuer(b.address)).to.equal(true);

      const inst = await manager.getInstitution(a.address);
      expect(inst.name).to.equal("ESPRIT");
      expect(inst.status).to.equal(Inst.Approved);
    });

    it("emits InstitutionApproved for each founder", async () => {
      const [a, b] = await ethers.getSigners();
      const manager = await ethers.deployContract("IssuerManager", [
        [a.address, b.address],
        ["ESPRIT", "Partner University"],
      ]);
      await expect(manager.deploymentTransaction())
        .to.emit(manager, "InstitutionApproved")
        .withArgs(a.address, "ESPRIT")
        .and.to.emit(manager, "InstitutionApproved")
        .withArgs(b.address, "Partner University");
    });

    it("returns false (without reverting) for an unknown address", async () => {
      const { manager, stranger } = await loadFixture(twoFoundersFixture);
      expect(await manager.isApprovedIssuer(stranger.address)).to.equal(false);
      expect(await manager.isApprovedIssuer(ethers.ZeroAddress)).to.equal(false);
    });

    it("reverts without founders", async () => {
      const { manager } = await loadFixture(twoFoundersFixture);
      await expect(ethers.deployContract("IssuerManager", [[], []])).to.be.revertedWithCustomError(
        manager,
        "NoFounders"
      );
    });

    it("reverts with more than MAX_FOUNDERS founders", async () => {
      const { manager } = await loadFixture(twoFoundersFixture);
      const founders = Array.from({ length: 11 }, () => ethers.Wallet.createRandom().address);
      const names = founders.map((_, i) => `University ${i}`);
      await expect(ethers.deployContract("IssuerManager", [founders, names]))
        .to.be.revertedWithCustomError(manager, "TooManyFounders")
        .withArgs(11);
    });

    it("reverts when founders and names lengths differ", async () => {
      const { manager, a } = await loadFixture(twoFoundersFixture);
      await expect(
        ethers.deployContract("IssuerManager", [[a.address], ["ESPRIT", "Extra"]])
      ).to.be.revertedWithCustomError(manager, "LengthMismatch");
    });

    it("reverts on the zero address", async () => {
      const { manager } = await loadFixture(twoFoundersFixture);
      await expect(
        ethers.deployContract("IssuerManager", [[ethers.ZeroAddress], ["ESPRIT"]])
      ).to.be.revertedWithCustomError(manager, "InvalidAddress");
    });

    it("reverts on a duplicate founder", async () => {
      const { manager, a } = await loadFixture(twoFoundersFixture);
      await expect(
        ethers.deployContract("IssuerManager", [[a.address, a.address], ["ESPRIT", "ESPRIT 2"]])
      )
        .to.be.revertedWithCustomError(manager, "DuplicateFounder")
        .withArgs(a.address);
    });

    it("reverts on an empty or too long founder name", async () => {
      const { manager, a } = await loadFixture(twoFoundersFixture);
      await expect(
        ethers.deployContract("IssuerManager", [[a.address], [""]])
      ).to.be.revertedWithCustomError(manager, "InvalidName");
      await expect(
        ethers.deployContract("IssuerManager", [[a.address], ["x".repeat(65)]])
      ).to.be.revertedWithCustomError(manager, "InvalidName");
    });
  });

  /* ------------------------------------------------------------------ */
  describe("applyToJoin", () => {
    it("opens an admission proposal and marks the applicant as pending", async () => {
      const { manager, applicant } = await loadFixture(twoFoundersFixture);

      const timestamp = await fixNextTimestamp();
      await expect(manager.connect(applicant).applyToJoin("New University"))
        .to.emit(manager, "InstitutionApplied")
        .withArgs(applicant.address, 1n, "New University");

      expect(await manager.proposalCount()).to.equal(1n);
      expect(await manager.openProposalOf(applicant.address)).to.equal(1n);

      const p = await manager.getProposal(1n);
      expect(p.kind).to.equal(Kind.Admission);
      expect(p.status).to.equal(Prop.Open);
      expect(p.target).to.equal(applicant.address);
      expect(p.proposer).to.equal(applicant.address);
      expect(p.createdAt).to.equal(timestamp);

      const inst = await manager.getInstitution(applicant.address);
      expect(inst.name).to.equal("New University");
      expect(inst.status).to.equal(Inst.Pending);
      expect(await manager.isApprovedIssuer(applicant.address)).to.equal(false);
    });

    it("reverts for an existing member", async () => {
      const { manager, a } = await loadFixture(twoFoundersFixture);
      await expect(manager.connect(a).applyToJoin("ESPRIT again"))
        .to.be.revertedWithCustomError(manager, "AlreadyMember")
        .withArgs(a.address);
    });

    it("reverts when an application is already open", async () => {
      const { manager, applicant } = await loadFixture(applicationFixture);
      await expect(manager.connect(applicant).applyToJoin("New University"))
        .to.be.revertedWithCustomError(manager, "OpenProposalExists")
        .withArgs(applicant.address, 1n);
    });

    it("reverts on an invalid name", async () => {
      const { manager, applicant } = await loadFixture(twoFoundersFixture);
      await expect(manager.connect(applicant).applyToJoin("")).to.be.revertedWithCustomError(
        manager,
        "InvalidName"
      );
    });
  });

  /* ------------------------------------------------------------------ */
  describe("vote on an admission", () => {
    it("needs a strict majority: 1 yes out of 2 members is not enough", async () => {
      const { manager, a, applicant } = await loadFixture(applicationFixture);

      expect(await manager.requiredVotes(1n)).to.equal(2n);
      await expect(manager.connect(a).vote(1n, true))
        .to.emit(manager, "VoteCast")
        .withArgs(1n, a.address, true);

      expect((await manager.getProposal(1n)).status).to.equal(Prop.Open);
      expect(await manager.hasVoted(1n, a.address)).to.equal(true);
      expect(await manager.isApprovedIssuer(applicant.address)).to.equal(false);
    });

    it("approves the applicant on the deciding vote", async () => {
      const { manager, a, b, applicant } = await loadFixture(applicationFixture);
      await manager.connect(a).vote(1n, true);

      await expect(manager.connect(b).vote(1n, true))
        .to.emit(manager, "ProposalClosed")
        .withArgs(1n, Prop.Approved)
        .and.to.emit(manager, "InstitutionApproved")
        .withArgs(applicant.address, "New University");

      expect(await manager.isApprovedIssuer(applicant.address)).to.equal(true);
      expect(await manager.memberCount()).to.equal(3n);
      expect(await manager.openProposalOf(applicant.address)).to.equal(0n);
      const p = await manager.getProposal(1n);
      expect(p.yesVotes).to.equal(2n);
      expect(p.closedAt).to.not.equal(0n);
    });

    it("rejects the applicant once the majority can no longer be reached", async () => {
      const { manager, a, applicant } = await loadFixture(applicationFixture);

      await expect(manager.connect(a).vote(1n, false))
        .to.emit(manager, "ProposalClosed")
        .withArgs(1n, Prop.Rejected);

      expect((await manager.getInstitution(applicant.address)).status).to.equal(Inst.Rejected);
      expect(await manager.isApprovedIssuer(applicant.address)).to.equal(false);
    });

    it("lets a rejected institution apply again", async () => {
      const { manager, a, applicant } = await loadFixture(applicationFixture);
      await manager.connect(a).vote(1n, false);

      await expect(manager.connect(applicant).applyToJoin("New University"))
        .to.emit(manager, "InstitutionApplied")
        .withArgs(applicant.address, 2n, "New University");
    });

    it("reverts when a non-member votes", async () => {
      const { manager, stranger } = await loadFixture(applicationFixture);
      await expect(manager.connect(stranger).vote(1n, true))
        .to.be.revertedWithCustomError(manager, "NotMember")
        .withArgs(stranger.address);
    });

    it("reverts when a member votes twice", async () => {
      const { manager, a } = await loadFixture(applicationFixture);
      await manager.connect(a).vote(1n, true);
      await expect(manager.connect(a).vote(1n, true))
        .to.be.revertedWithCustomError(manager, "AlreadyVoted")
        .withArgs(1n, a.address);
    });

    it("reverts on a closed or unknown proposal", async () => {
      const { manager, a, b } = await loadFixture(applicationFixture);
      await manager.connect(a).vote(1n, false);

      await expect(manager.connect(b).vote(1n, true))
        .to.be.revertedWithCustomError(manager, "ProposalNotOpen")
        .withArgs(1n);
      await expect(manager.connect(b).vote(99n, true))
        .to.be.revertedWithCustomError(manager, "ProposalNotOpen")
        .withArgs(99n);
    });
  });

  /* ------------------------------------------------------------------ */
  describe("withdrawApplication", () => {
    it("cancels the open application", async () => {
      const { manager, a, applicant } = await loadFixture(applicationFixture);

      await expect(manager.connect(applicant).withdrawApplication())
        .to.emit(manager, "ProposalClosed")
        .withArgs(1n, Prop.Cancelled);

      expect((await manager.getInstitution(applicant.address)).status).to.equal(Inst.None);
      expect(await manager.openProposalOf(applicant.address)).to.equal(0n);
      await expect(manager.connect(a).vote(1n, true)).to.be.revertedWithCustomError(
        manager,
        "ProposalNotOpen"
      );
    });

    it("reverts without an open application", async () => {
      const { manager, stranger } = await loadFixture(twoFoundersFixture);
      await expect(manager.connect(stranger).withdrawApplication())
        .to.be.revertedWithCustomError(manager, "NoOpenApplication")
        .withArgs(stranger.address);
    });

    it("cannot be used to cancel a removal proposal", async () => {
      const { manager, a, b } = await loadFixture(threeFoundersFixture);
      await manager.connect(a).proposeRemoval(b.address);
      await expect(manager.connect(b).withdrawApplication())
        .to.be.revertedWithCustomError(manager, "NoOpenApplication")
        .withArgs(b.address);
    });
  });

  /* ------------------------------------------------------------------ */
  describe("removal", () => {
    it("opens a removal proposal", async () => {
      const { manager, a, c } = await loadFixture(threeFoundersFixture);

      await expect(manager.connect(a).proposeRemoval(c.address))
        .to.emit(manager, "RemovalProposed")
        .withArgs(1n, c.address, a.address);

      const p = await manager.getProposal(1n);
      expect(p.kind).to.equal(Kind.Removal);
      expect(p.proposer).to.equal(a.address);
      // 3 members, the target cannot vote: 2 eligible, majority = 2.
      expect(await manager.requiredVotes(1n)).to.equal(2n);
    });

    it("removes the member with a majority of the other members", async () => {
      const { manager, a, b, c } = await loadFixture(threeFoundersFixture);
      await manager.connect(a).proposeRemoval(b.address);
      await manager.connect(a).vote(1n, true);

      await expect(manager.connect(c).vote(1n, true))
        .to.emit(manager, "InstitutionRemoved")
        .withArgs(b.address)
        .and.to.emit(manager, "ProposalClosed")
        .withArgs(1n, Prop.Approved);

      expect(await manager.isApprovedIssuer(b.address)).to.equal(false);
      expect((await manager.getInstitution(b.address)).status).to.equal(Inst.Removed);
      expect(await manager.memberCount()).to.equal(2n);
      // b was in the middle: c is swapped into its slot.
      expect(await manager.getMembers()).to.deep.equal([a.address, c.address]);
    });

    it("keeps the member when the removal is rejected", async () => {
      const { manager, a, b, c } = await loadFixture(threeFoundersFixture);
      await manager.connect(a).proposeRemoval(c.address);

      await expect(manager.connect(b).vote(1n, false))
        .to.emit(manager, "ProposalClosed")
        .withArgs(1n, Prop.Rejected);
      expect(await manager.isApprovedIssuer(c.address)).to.equal(true);
    });

    it("lets a removed institution apply again", async () => {
      const { manager, a, b, c } = await loadFixture(threeFoundersFixture);
      await manager.connect(a).proposeRemoval(c.address);
      await manager.connect(a).vote(1n, true);
      await manager.connect(b).vote(1n, true);

      await expect(manager.connect(c).applyToJoin("Third University"))
        .to.emit(manager, "InstitutionApplied")
        .withArgs(c.address, 2n, "Third University");
    });

    it("does not let the target vote on its own removal", async () => {
      const { manager, a, b } = await loadFixture(threeFoundersFixture);
      await manager.connect(a).proposeRemoval(b.address);
      await expect(manager.connect(b).vote(1n, false)).to.be.revertedWithCustomError(
        manager,
        "CannotVoteOnOwnRemoval"
      );
    });

    it("reverts when proposing your own removal", async () => {
      const { manager, a } = await loadFixture(threeFoundersFixture);
      await expect(manager.connect(a).proposeRemoval(a.address)).to.be.revertedWithCustomError(
        manager,
        "CannotProposeOwnRemoval"
      );
    });

    it("reverts when the target is not a member", async () => {
      const { manager, a, stranger } = await loadFixture(threeFoundersFixture);
      await expect(manager.connect(a).proposeRemoval(stranger.address))
        .to.be.revertedWithCustomError(manager, "NotMember")
        .withArgs(stranger.address);
    });

    it("reverts when a non-member proposes a removal", async () => {
      const { manager, a, stranger } = await loadFixture(threeFoundersFixture);
      await expect(manager.connect(stranger).proposeRemoval(a.address))
        .to.be.revertedWithCustomError(manager, "NotMember")
        .withArgs(stranger.address);
    });

    it("reverts when a removal is already open for the target", async () => {
      const { manager, a, b, c } = await loadFixture(threeFoundersFixture);
      await manager.connect(a).proposeRemoval(c.address);
      await expect(manager.connect(b).proposeRemoval(c.address))
        .to.be.revertedWithCustomError(manager, "OpenProposalExists")
        .withArgs(c.address, 1n);
    });
  });

  /* ------------------------------------------------------------------ */
  describe("leave", () => {
    it("lets a member leave voluntarily", async () => {
      const { manager, a, b } = await loadFixture(twoFoundersFixture);

      await expect(manager.connect(a).leave()).to.emit(manager, "InstitutionLeft").withArgs(a.address);

      expect(await manager.isApprovedIssuer(a.address)).to.equal(false);
      expect((await manager.getInstitution(a.address)).status).to.equal(Inst.Left);
      expect(await manager.getMembers()).to.deep.equal([b.address]);
    });

    it("cancels an open removal proposal about the leaving member", async () => {
      const { manager, a, b } = await loadFixture(threeFoundersFixture);
      await manager.connect(a).proposeRemoval(b.address);

      await expect(manager.connect(b).leave())
        .to.emit(manager, "ProposalClosed")
        .withArgs(1n, Prop.Cancelled);
      expect(await manager.openProposalOf(b.address)).to.equal(0n);
    });

    it("does not let the last member leave", async () => {
      const [a] = await ethers.getSigners();
      const manager = await ethers.deployContract("IssuerManager", [[a.address], ["ESPRIT"]]);
      await expect(manager.connect(a).leave()).to.be.revertedWithCustomError(manager, "LastMember");
    });

    it("reverts for a non-member", async () => {
      const { manager, stranger } = await loadFixture(twoFoundersFixture);
      await expect(manager.connect(stranger).leave())
        .to.be.revertedWithCustomError(manager, "NotMember")
        .withArgs(stranger.address);
    });
  });

  /* ------------------------------------------------------------------ */
  describe("finalize", () => {
    it("rejects a proposal that became decided after a member left", async () => {
      const { manager, a, b, c, applicant } = await loadFixture(threeFoundersFixture);
      await manager.connect(applicant).applyToJoin("New University");
      await manager.connect(a).vote(1n, true);
      await manager.connect(b).vote(1n, false);
      // 1 yes, 1 no, c could still decide -> open.
      expect((await manager.getProposal(1n)).status).to.equal(Prop.Open);

      await manager.connect(c).leave();
      // 2 members left, both voted, yes can no longer reach 2.
      await expect(manager.finalize(1n)).to.emit(manager, "ProposalClosed").withArgs(1n, Prop.Rejected);
    });

    it("approves a proposal that became decided after a member left", async () => {
      const [a, b, c, d, applicant] = await ethers.getSigners();
      const manager = await ethers.deployContract("IssuerManager", [
        [a.address, b.address, c.address, d.address],
        ["U1", "U2", "U3", "U4"],
      ]);
      await manager.connect(applicant).applyToJoin("New University");
      await manager.connect(a).vote(1n, true);
      await manager.connect(b).vote(1n, true);
      // 4 members -> 3 needed.
      expect((await manager.getProposal(1n)).status).to.equal(Prop.Open);

      await manager.connect(d).leave();
      // 3 members -> 2 needed, already reached.
      await expect(manager.finalize(1n)).to.emit(manager, "ProposalClosed").withArgs(1n, Prop.Approved);
      expect(await manager.isApprovedIssuer(applicant.address)).to.equal(true);
    });

    it("rejects a removal when nobody is left to vote on it", async () => {
      const { manager, a, b } = await loadFixture(twoFoundersFixture);
      await manager.connect(a).proposeRemoval(b.address);
      await manager.connect(a).leave();
      // Only the target is left: 0 eligible voters.
      await expect(manager.finalize(1n)).to.emit(manager, "ProposalClosed").withArgs(1n, Prop.Rejected);
      expect(await manager.isApprovedIssuer(b.address)).to.equal(true);
    });

    it("does nothing while the outcome is undecided", async () => {
      const { manager } = await loadFixture(applicationFixture);
      await expect(manager.finalize(1n)).to.not.emit(manager, "ProposalClosed");
      expect((await manager.getProposal(1n)).status).to.equal(Prop.Open);
    });

    it("reverts on a proposal that is not open", async () => {
      const { manager } = await loadFixture(twoFoundersFixture);
      await expect(manager.finalize(1n))
        .to.be.revertedWithCustomError(manager, "ProposalNotOpen")
        .withArgs(1n);
    });
  });
});
