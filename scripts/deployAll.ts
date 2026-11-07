import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Deploys the real IssuerManager (consortium, no admin) and a CertificateRegistry linked to it.
// Usage:
//   FOUNDER_ADDRESSES=0xAAA,0xBBB FOUNDER_NAMES="ESPRIT,Partner University" \
//     npx hardhat run scripts/deployAll.ts --network sepolia
// (or set both variables in .env)
function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function main() {
  const founders = parseList(process.env.FOUNDER_ADDRESSES);
  const names = parseList(process.env.FOUNDER_NAMES);

  if (founders.length === 0) {
    throw new Error("FOUNDER_ADDRESSES is missing (comma-separated wallet addresses).");
  }
  if (names.length !== founders.length) {
    throw new Error("FOUNDER_NAMES must have one name per address in FOUNDER_ADDRESSES.");
  }
  for (const founder of founders) {
    if (!ethers.isAddress(founder)) throw new Error(`Invalid founder address: ${founder}`);
  }

  const [deployer] = await ethers.getSigners();
  console.log(`Network:   ${network.name}`);
  console.log(`Deployer:  ${deployer.address}`);
  founders.forEach((founder, i) => console.log(`Founder ${i + 1}: ${names[i]} (${founder})`));

  const manager = await ethers.deployContract("IssuerManager", [founders, names]);
  await manager.waitForDeployment();
  const managerAddress = await manager.getAddress();
  const managerReceipt = await manager.deploymentTransaction()?.wait();
  console.log(`IssuerManager deployed at:       ${managerAddress}`);

  const registry = await ethers.deployContract("CertificateRegistry", [managerAddress]);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  const registryReceipt = await registry.deploymentTransaction()?.wait();
  console.log(`CertificateRegistry deployed at: ${registryAddress}`);

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        network: network.name,
        deployer: deployer.address,
        issuerManager: managerAddress,
        issuerManagerDeployBlock: managerReceipt?.blockNumber,
        certificateRegistry: registryAddress,
        deployedAt: new Date().toISOString(),
        deployBlock: registryReceipt?.blockNumber,
        founders: founders.map((address, i) => ({ address, name: names[i] })),
      },
      null,
      2
    )
  );
  console.log(`Saved to ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
