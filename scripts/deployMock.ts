import { ethers, network } from "hardhat";

// Deploys MockIssuerManager and approves the deployer wallet as an issuer,
// so you can test CertificateRegistry on Sepolia before the real IssuerManager exists.
//
// Usage:
//   npx hardhat run scripts/deployMock.ts --network sepolia
// Then put the printed address in ISSUER_MANAGER_ADDRESS and run scripts/deploy.ts.
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);

  const mock = await ethers.deployContract("MockIssuerManager");
  await mock.waitForDeployment();
  const mockAddress = await mock.getAddress();
  console.log(`MockIssuerManager deployed at: ${mockAddress}`);

  const tx = await mock.setApproved(deployer.address, true);
  await tx.wait();
  console.log(`Approved issuer: ${deployer.address}`);
  console.log(`\nNext: set ISSUER_MANAGER_ADDRESS=${mockAddress} then run scripts/deploy.ts`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
