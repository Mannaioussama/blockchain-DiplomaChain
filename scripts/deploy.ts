import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Usage:
//   ISSUER_MANAGER_ADDRESS=0x... npx hardhat run scripts/deploy.ts --network sepolia
// (or set ISSUER_MANAGER_ADDRESS in .env)
async function main() {
  const issuerManagerAddress = process.env.ISSUER_MANAGER_ADDRESS;

  if (!issuerManagerAddress || !ethers.isAddress(issuerManagerAddress)) {
    throw new Error(
      "ISSUER_MANAGER_ADDRESS is missing or is not a valid address. Set it in .env or in the shell."
    );
  }

  const [deployer] = await ethers.getSigners();
  console.log(`Network:        ${network.name}`);
  console.log(`Deployer:       ${deployer.address}`);
  console.log(`IssuerManager:  ${issuerManagerAddress}`);

  const registry = await ethers.deployContract("CertificateRegistry", [issuerManagerAddress]);
  await registry.waitForDeployment();

  const registryAddress = await registry.getAddress();
  console.log(`CertificateRegistry deployed at: ${registryAddress}`);

  // Save the addresses so the web interface can read them later.
  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        network: network.name,
        deployer: deployer.address,
        issuerManager: issuerManagerAddress,
        certificateRegistry: registryAddress,
        deployedAt: new Date().toISOString(),
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
