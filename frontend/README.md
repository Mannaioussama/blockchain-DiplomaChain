# DiplomaChain frontend

Simple React (Vite) + ethers v6 UI for Sepolia.

## Pages

- **Issuer** — connect MetaMask (Sepolia), see approval status, issue / revoke a certificate hash
- **Verifier** — no wallet required; shows status, dates, `issuerApproved`, and a warning when the diploma is Valid but the issuer is no longer accredited

PDF hashing is done in the browser (`keccak256` of the file bytes). The PDF never leaves the device.

Contract address: `src/contracts/sepolia.json`  
ABI: `src/contracts/CertificateRegistryAbi.json` (copied from Hardhat artifacts)

## Run

```bash
cd frontend
npm install
npm run dev
```

Then open the printed local URL (usually http://localhost:5173).
