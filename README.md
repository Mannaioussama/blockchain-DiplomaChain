# DiplomaChain

Vérification décentralisée de diplômes (mini-projet Blockchain, ESPRIT). Deux contrats :

- `CertificateRegistry` : émission, révocation et vérification des certificats.
- `IssuerManager` : consortium des établissements habilités à émettre, **sans admin** (vote des membres).

Seul le hash `keccak256` du PDF du diplôme est stocké on-chain, jamais le document ni de données personnelles.
`CertificateRegistry` interroge `IssuerManager.isApprovedIssuer(address)` pour savoir si un établissement est approuvé.

## IssuerManager — consortium sans admin

- Les établissements **fondateurs** sont fixés une seule fois au déploiement ; ensuite personne n'a de pouvoir spécial.
- `applyToJoin(name)` : un établissement demande à rejoindre le consortium (statut `Pending`).
- `vote(proposalId, support)` : chaque membre vote ; la **majorité stricte** des votants éligibles décide,
  et la proposition se clôture automatiquement au vote décisif.
- `proposeRemoval(target)` : un membre propose de retirer un autre membre ; la cible ne vote pas sur son propre retrait.
- `leave()` : un membre quitte volontairement le consortium (sauf le dernier membre).
- `withdrawApplication()` : le candidat retire sa demande.
- `finalize(proposalId)` : clôture une proposition devenue décidée après un changement du nombre de membres.
- `isApprovedIssuer(address)` : `view`, renvoie `false` (sans revert) pour une adresse inconnue, candidate, refusée, retirée ou partie.

## Règles métier

- Seul un émetteur **actuellement approuvé** par `IssuerManager` peut émettre un certificat.
- Si un émetteur est retiré, il ne peut plus émettre, mais **ses diplômes déjà émis restent valides**.
- `isValid(hash)` : `true` si le certificat existe et n'est pas révoqué (indépendant du statut de l'émetteur).
- `verifyCertificate(hash)` : retourne `(status, issuer, issuedAt, revokedAt, issuerApproved)`.
  `issuerApproved` indique si l'établissement est **toujours** approuvé : l'interface doit afficher un avertissement quand il vaut `false`.
- Seul l'émetteur d'origine peut révoquer un certificat (même s'il a été retiré depuis). La révocation est définitive : un hash révoqué ne peut jamais être ré-émis.

## Bonus — lots Merkle (batch)

Émettre toute une promotion en **une transaction** via une racine Merkle (OpenZeppelin `StandardMerkleTree` / `MerkleProof`) :

- `issueBatch(merkleRoot, count)` — `count` est **informatif seulement** (non vérifiable on-chain)
- `verifyInBatch(root, certHash, proof)` — valide si la preuve est correcte et la feuille n'est pas révoquée ; expose aussi `issuerApproved`
- `revokeBatchLeaf(root, certHash, proof)` — révocation **par diplôme** (pas toute la promo) ; preuve obligatoire
- Feuille = `keccak256(bytes.concat(keccak256(abi.encode(certHash))))` (double hash anti second-preimage)
- Preuve plafonnée à `MAX_PROOF_LENGTH = 32` (gaz borné)
- Namespace séparé : `isValid(hash)` **ne voit pas** les lots Merkle

## Structure

```
contracts/
  CertificateRegistry.sol              Registre des diplômes (+ bonus Merkle)
  IssuerManager.sol                    Consortium des établissements (vote, sans admin)
  interfaces/IIssuerManager.sol        Interface commune aux deux contrats
  mocks/MockIssuerManager.sol          Mock pour les tests unitaires du registre
  mocks/MockRevertingIssuerManager.sol Mock de test (IssuerManager défaillant)
scripts/
  deployAll.ts                         Déploie IssuerManager (fondateurs) + CertificateRegistry
  deployMock.ts                        Déploie le mock et approuve le wallet du déployeur
  deploy.ts                            Déploie CertificateRegistry (adresse lue dans ISSUER_MANAGER_ADDRESS)
  mockSetApproval.ts                   Approuve / retire un émetteur sur le MOCK uniquement
test/
  CertificateRegistry.test.ts          Tests unitaires individuels
  CertificateRegistry.batch.test.ts    Tests du bonus Merkle
  IssuerManager.test.ts                Tests du consortium (candidature, vote, retrait, départ)
  Integration.test.ts                  Vrai IssuerManager + CertificateRegistry ensemble
frontend/                              Interface web React (Issuer + Verifier, Sepolia)
deployments/sepolia.json               Adresses déployées (lues par le frontend)
```

## Interface web

```bash
npm run frontend:dev
# ou: cd frontend && npm install && npm run dev
```

- **Connexion avec MetaMask** (pas d'email ni de mot de passe) : l'utilisateur signe un message
  au format « Sign-In with Ethereum » (gratuit, aucune transaction). Le rôle est lu **on-chain** dans `IssuerManager`.
- **Issuer** : établissements membres (et anciens membres, pour révoquer leurs propres diplômes).
- **Consortium** : statut de l'établissement, candidature, membres, propositions et votes (aucune page admin).
- **Verifier** : public, sans connexion ; affiche le nom de l'établissement émetteur et un avertissement s'il n'est plus membre.

La connexion est une commodité d'interface : la vraie sécurité reste la signature des transactions,
vérifiée par les contrats. Le hash du PDF est calculé dans le navigateur ; le fichier ne quitte jamais l'appareil.

## Installation

```bash
npm install
npx hardhat compile
```

## Tests et couverture

```bash
npm test             # tests unitaires
npm run coverage     # couverture (rapport HTML dans coverage/index.html)
```

## Déploiement sur Sepolia

1. Copier `.env.example` vers `.env` et remplir :
   - `SEPOLIA_RPC_URL` : URL RPC Sepolia (Alchemy, Infura, ou RPC public) ;
   - `DEPLOYER_PRIVATE_KEY` : clé privée d'un **wallet de test uniquement** (jamais le compte principal) ;
   - `ETHERSCAN_API_KEY` : seulement pour la vérification du code.
2. Ajouter un peu de Sepolia ETH au wallet de test (faucet Sepolia).
3. Déployer le mock (tant que le vrai `IssuerManager` n'est pas déployé) :
   ```bash
   npm run deploy:mock:sepolia
   ```
   Le script affiche l'adresse du mock et approuve le wallet du déployeur comme émetteur.
4. Mettre cette adresse dans `ISSUER_MANAGER_ADDRESS` (fichier `.env`), puis déployer le registre :
   ```bash
   npm run deploy:sepolia
   ```
   Les adresses sont enregistrées dans `deployments/sepolia.json` (lu ensuite par l'interface web).
5. Vérifier le code sur Etherscan (optionnel) :
   ```bash
   npx hardhat verify --network sepolia <ADRESSE_REGISTRY> <ADRESSE_ISSUER_MANAGER>
   ```

### Déployer les deux vrais contrats

Remplir `FOUNDER_ADDRESSES` et `FOUNDER_NAMES` dans `.env` (listes séparées par des virgules, même ordre), puis :

```bash
npm run deploy:all:sepolia
```

Le script déploie `IssuerManager` avec ses fondateurs, puis un `CertificateRegistry` lié à lui, et écrit `deployments/sepolia.json`.
L'adresse de l'`IssuerManager` est fixée dans le registre (`immutable`) : c'est un **nouveau** registre vide,
les certificats de l'ancien registre (lié au mock) ne sont pas migrés.

### Tester le cas « émetteur retiré » avec le mock

```bash
ISSUER_MANAGER_ADDRESS=0x... ISSUER_ADDRESS=0x... APPROVED=false \
  npx hardhat run scripts/mockSetApproval.ts --network sepolia
```

Puis `verifyCertificate` renvoie `issuerApproved = false` alors que `isValid` reste `true`.
(`APPROVED=true` pour approuver un nouvel émetteur.) Ce script ne fonctionne qu'avec le mock, et seulement avec le wallet qui l'a déployé.

## Limites connues (à mentionner dans le rapport)

- Les diplômes d'un émetteur retiré restent valides (choix assumé) : le vérificateur doit toujours consulter `issuerApproved`.
- Un émetteur retiré peut encore révoquer ses propres diplômes.
- Un hash de PDF prévisible peut être deviné par dictionnaire : intégrer un sel aléatoire dans le document avant de le hasher.
- L'adresse de l'`IssuerManager` ne peut pas être changée sans redéployer le registre.
- Un émetteur approuvé peut enregistrer le hash d'un document avant l'émetteur légitime (risque limité aux émetteurs approuvés).
- Consortium : la majorité est calculée sur le nombre **actuel** de membres ; un vote déjà exprimé par un membre parti ou retiré reste compté.
- Consortium à 2 membres : un seul membre suffit pour retirer l'autre (la cible ne vote pas). Prévoir au moins 3 membres en production.
- Une proposition n'expire pas : elle reste ouverte tant que la majorité n'est pas atteinte (le candidat peut retirer sa demande).
- Le registre fait entièrement confiance à l'`IssuerManager` (hypothèse de confiance).

## Sécurité

Ne jamais commiter `.env` ni une clé privée. Utiliser uniquement un wallet de test sur Sepolia.
