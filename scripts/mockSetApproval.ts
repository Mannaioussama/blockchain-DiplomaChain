import { ethers, network } from "hardhat";

// MOCK ONLY: approve or remove an issuer on MockIssuerManager.
// Useful to test/demo the `issuerApproved` flag before the real IssuerManager exists.
// With the real IssuerManager, approvals are done through your partner's contract instead.
//
// Usage (approve):
//   ISSUER_MANAGER_ADDRESS=0x... ISSUER_ADDRESS=0x... APPROVED=true \
//     npx hardhat run scripts/mockSetApproval.ts --network sepolia
// Usage (remove): same with APPROVED=false
async function main() {
  const managerAddress = process.env.ISSUER_MANAGER_ADDRESS;
  const issuerAddress = process.env.ISSUER_ADDRESS;
  const approvedRaw = process.env.APPROVED;

  if (!managerAddress || !ethers.isAddress(managerAddress)) {
    throw new Error("ISSUER_MANAGER_ADDRESS is missing or is not a valid address.");
  }
  if (!issuerAddress || !ethers.isAddress(issuerAddress)) {
    throw new Error("ISSUER_ADDRESS is missing or is not a valid address.");
  }
  if (approvedRaw !== "true" && approvedRaw !== "false") {
    throw new Error('APPROVED must be "true" or "false".');
  }
  const approved = approvedRaw === "true";

  const [signer] = await ethers.getSigners();
  console.log(`Network: ${network.name}`);
  console.log(`Signer:  ${signer.address} (must be the MockIssuerManager deployer)`);

  const mock = await ethers.getContractAt("MockIssuerManager", managerAddress);
  const tx = await mock.setApproved(issuerAddress, approved);
  await tx.wait();

  console.log(`${issuerAddress} is now ${approved ? "APPROVED" : "REMOVED"} on ${managerAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
