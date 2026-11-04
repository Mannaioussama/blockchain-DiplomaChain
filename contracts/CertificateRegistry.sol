// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IIssuerManager} from "./interfaces/IIssuerManager.sol";

/// @title CertificateRegistry
/// @notice Registry of diploma hashes. Only the keccak256 hash of the diploma PDF is stored,
///         never the document nor any personal data.
/// @dev Rules agreed with the IssuerManager owner:
///      - Only an issuer currently approved by IssuerManager can issue a certificate.
///      - If an issuer is later removed, it can no longer issue, but the certificates it
///        already issued stay valid (`isValid` does not depend on the issuer's current status).
///      - `verifyCertificate` also reports whether the issuer is still approved, so a verifier
///        can see if the institution is still accredited.
///      - Only the original issuer can revoke a certificate. Revocation is final.
///      - Merkle batches (bonus): one root commits to many diploma hashes. Batches live in a
///        separate namespace from individual certificates (`isValid` does not see batches).
///        Leaf hashing matches OpenZeppelin StandardMerkleTree:
///        `keccak256(bytes.concat(keccak256(abi.encode(certHash))))`.
contract CertificateRegistry {
    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @dev None = 0 so that an unknown hash is distinguishable from an issued one.
    enum Status {
        None,
        Valid,
        Revoked
    }

    /// @dev Packed in a single storage slot: 20 + 5 + 5 + 1 = 31 bytes.
    struct Certificate {
        address issuer;
        uint40 issuedAt;
        uint40 revokedAt; // 0 while not revoked
        Status status;
    }

    /// @dev One Merkle batch issued by an approved issuer.
    /// @param count Informational only — the contract cannot verify how many leaves the issuer
    ///              actually put in the off-chain tree.
    struct Batch {
        address issuer;
        uint40 issuedAt;
        uint32 count;
        bool exists;
    }

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice IssuerManager contract used to check issuer approval (fixed at deployment).
    IIssuerManager public immutable issuerManager;

    /// @notice Max Merkle proof length accepted on-chain (keeps gas bounded).
    uint256 public constant MAX_PROOF_LENGTH = 32;

    /// @dev certHash (keccak256 of the PDF) => certificate data
    mapping(bytes32 certHash => Certificate) private _certificates;

    /// @dev merkleRoot => batch metadata
    mapping(bytes32 root => Batch) private _batches;

    /// @dev merkleRoot => leaf (double-hashed certHash) => revoked
    mapping(bytes32 root => mapping(bytes32 leaf => bool revoked)) private _batchLeafRevoked;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event CertificateIssued(bytes32 indexed certHash, address indexed issuer, uint40 issuedAt);
    event CertificateRevoked(bytes32 indexed certHash, address indexed issuer, uint40 revokedAt);
    event BatchIssued(bytes32 indexed merkleRoot, address indexed issuer, uint32 count, uint40 issuedAt);
    event BatchLeafRevoked(
        bytes32 indexed merkleRoot, bytes32 indexed certHash, address indexed issuer, uint40 revokedAt
    );

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error InvalidIssuerManager(address issuerManager);
    error NotApprovedIssuer(address caller);
    error InvalidHash();
    error CertificateAlreadyExists(bytes32 certHash);
    error CertificateNotFound(bytes32 certHash);
    error CertificateAlreadyRevoked(bytes32 certHash);
    error NotCertificateIssuer(address caller, address issuer);
    error BatchAlreadyExists(bytes32 merkleRoot);
    error BatchNotFound(bytes32 merkleRoot);
    error InvalidProof();
    error LeafAlreadyRevoked(bytes32 merkleRoot, bytes32 certHash);
    error NotBatchIssuer(address caller, address issuer);
    error ProofTooLong(uint256 length);

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param issuerManager_ Address of a deployed IssuerManager (real or mock).
    constructor(address issuerManager_) {
        // Rejecting address(0) and non-contract addresses also guarantees that later
        // high-level calls to the IssuerManager never hit an address without code.
        if (issuerManager_ == address(0) || issuerManager_.code.length == 0) {
            revert InvalidIssuerManager(issuerManager_);
        }
        issuerManager = IIssuerManager(issuerManager_);
    }

    /*//////////////////////////////////////////////////////////////
                               MODIFIERS
    //////////////////////////////////////////////////////////////*/

    /// @dev The external call is a `view` function (STATICCALL), so no reentrancy is possible.
    modifier onlyApprovedIssuer() {
        if (!issuerManager.isApprovedIssuer(msg.sender)) revert NotApprovedIssuer(msg.sender);
        _;
    }

    /*//////////////////////////////////////////////////////////////
                              STATE-CHANGING
    //////////////////////////////////////////////////////////////*/

    /// @notice Register a diploma hash. Caller must be a currently approved issuer.
    /// @param certHash keccak256 of the diploma PDF.
    function issueCertificate(bytes32 certHash) external onlyApprovedIssuer {
        if (certHash == bytes32(0)) revert InvalidHash();
        // Also blocks re-issuing a revoked hash: a revoked certificate can never come back.
        if (_certificates[certHash].status != Status.None) revert CertificateAlreadyExists(certHash);

        uint40 nowTs = uint40(block.timestamp);
        _certificates[certHash] = Certificate({
            issuer: msg.sender,
            issuedAt: nowTs,
            revokedAt: 0,
            status: Status.Valid
        });

        emit CertificateIssued(certHash, msg.sender, nowTs);
    }

    /// @notice Revoke a certificate. Only the issuer that issued it can revoke it.
    /// @dev Intentionally does NOT require the issuer to still be approved, so an institution
    ///      removed from the IssuerManager can still correct its own mistakes.
    /// @param certHash keccak256 of the diploma PDF.
    function revokeCertificate(bytes32 certHash) external {
        Certificate storage cert = _certificates[certHash];

        if (cert.status == Status.None) revert CertificateNotFound(certHash);
        if (cert.status == Status.Revoked) revert CertificateAlreadyRevoked(certHash);
        if (cert.issuer != msg.sender) revert NotCertificateIssuer(msg.sender, cert.issuer);

        uint40 nowTs = uint40(block.timestamp);
        cert.status = Status.Revoked;
        cert.revokedAt = nowTs;

        emit CertificateRevoked(certHash, msg.sender, nowTs);
    }

    /// @notice Issue a Merkle batch of diploma hashes in one transaction.
    /// @param merkleRoot Root of an OpenZeppelin StandardMerkleTree over `bytes32` cert hashes.
    /// @param count Informational leaf count claimed by the issuer (not verified on-chain).
    function issueBatch(bytes32 merkleRoot, uint32 count) external onlyApprovedIssuer {
        if (merkleRoot == bytes32(0)) revert InvalidHash();
        if (_batches[merkleRoot].exists) revert BatchAlreadyExists(merkleRoot);

        uint40 nowTs = uint40(block.timestamp);
        _batches[merkleRoot] = Batch({issuer: msg.sender, issuedAt: nowTs, count: count, exists: true});

        emit BatchIssued(merkleRoot, msg.sender, count, nowTs);
    }

    /// @notice Revoke one diploma leaf inside a batch. Requires a valid Merkle proof.
    /// @dev Only the batch issuer; does not require the issuer to still be approved.
    function revokeBatchLeaf(bytes32 merkleRoot, bytes32 certHash, bytes32[] calldata proof) external {
        Batch storage batch = _batches[merkleRoot];
        if (!batch.exists) revert BatchNotFound(merkleRoot);
        if (batch.issuer != msg.sender) revert NotBatchIssuer(msg.sender, batch.issuer);
        if (certHash == bytes32(0)) revert InvalidHash();
        if (proof.length > MAX_PROOF_LENGTH) revert ProofTooLong(proof.length);

        bytes32 leaf = _leafHash(certHash);
        if (!MerkleProof.verify(proof, merkleRoot, leaf)) revert InvalidProof();
        if (_batchLeafRevoked[merkleRoot][leaf]) revert LeafAlreadyRevoked(merkleRoot, certHash);

        uint40 nowTs = uint40(block.timestamp);
        _batchLeafRevoked[merkleRoot][leaf] = true;

        emit BatchLeafRevoked(merkleRoot, certHash, msg.sender, nowTs);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice True if the certificate exists and has not been revoked.
    /// @dev Does NOT depend on the issuer's current approval (see contract-level rules).
    ///      Does NOT look at Merkle batches (separate namespace).
    function isValid(bytes32 certHash) external view returns (bool) {
        return _certificates[certHash].status == Status.Valid;
    }

    /// @notice Full verification data for a certificate.
    /// @param certHash keccak256 of the diploma PDF.
    /// @return status         None (unknown), Valid or Revoked.
    /// @return issuer         Address of the issuing institution (address(0) if unknown).
    /// @return issuedAt       Issuance timestamp (0 if unknown).
    /// @return revokedAt      Revocation timestamp (0 if not revoked).
    /// @return issuerApproved Whether the issuer is STILL approved in IssuerManager right now.
    function verifyCertificate(bytes32 certHash)
        external
        view
        returns (Status status, address issuer, uint40 issuedAt, uint40 revokedAt, bool issuerApproved)
    {
        Certificate memory cert = _certificates[certHash];
        status = cert.status;
        issuer = cert.issuer;
        issuedAt = cert.issuedAt;
        revokedAt = cert.revokedAt;

        if (cert.status != Status.None) {
            issuerApproved = _isIssuerApproved(cert.issuer);
        }
    }

    /// @notice Verify that `certHash` is part of a batch and not revoked.
    /// @dev Same accreditation rule as individual certificates: a removed issuer does not
    ///      invalidate the batch; only `issuerApproved` flips to false.
    function verifyInBatch(bytes32 merkleRoot, bytes32 certHash, bytes32[] calldata proof)
        external
        view
        returns (bool valid, address issuer, uint40 issuedAt, bool revoked, bool issuerApproved)
    {
        Batch memory batch = _batches[merkleRoot];
        if (!batch.exists) {
            return (false, address(0), 0, false, false);
        }
        if (certHash == bytes32(0) || proof.length > MAX_PROOF_LENGTH) {
            return (false, batch.issuer, batch.issuedAt, false, _isIssuerApproved(batch.issuer));
        }

        bytes32 leaf = _leafHash(certHash);
        bool inTree = MerkleProof.verify(proof, merkleRoot, leaf);
        bool isRevoked = _batchLeafRevoked[merkleRoot][leaf];

        issuer = batch.issuer;
        issuedAt = batch.issuedAt;
        revoked = isRevoked;
        issuerApproved = _isIssuerApproved(batch.issuer);
        valid = inTree && !isRevoked;
    }

    /// @notice Batch metadata for a Merkle root (empty / exists=false if unknown).
    function getBatch(bytes32 merkleRoot)
        external
        view
        returns (address issuer, uint40 issuedAt, uint32 count, bool exists)
    {
        Batch memory batch = _batches[merkleRoot];
        return (batch.issuer, batch.issuedAt, batch.count, batch.exists);
    }

    /// @notice Whether a batch leaf was revoked (leaf = StandardMerkleTree double-hash of certHash).
    function isBatchLeafRevoked(bytes32 merkleRoot, bytes32 certHash) external view returns (bool) {
        return _batchLeafRevoked[merkleRoot][_leafHash(certHash)];
    }

    /*//////////////////////////////////////////////////////////////
                                 INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev OpenZeppelin StandardMerkleTree leaf for a single `bytes32` value.
    function _leafHash(bytes32 certHash) private pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(certHash))));
    }

    /// @dev try/catch so a failing IssuerManager can never make verification revert:
    ///      verification still works and simply reports `false`.
    function _isIssuerApproved(address issuer) private view returns (bool) {
        try issuerManager.isApprovedIssuer(issuer) returns (bool approved) {
            return approved;
        } catch {
            return false;
        }
    }
}
