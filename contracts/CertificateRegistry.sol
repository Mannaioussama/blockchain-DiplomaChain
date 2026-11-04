// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice IssuerManager contract used to check issuer approval (fixed at deployment).
    IIssuerManager public immutable issuerManager;

    /// @dev certHash (keccak256 of the PDF) => certificate data
    mapping(bytes32 certHash => Certificate) private _certificates;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event CertificateIssued(bytes32 indexed certHash, address indexed issuer, uint40 issuedAt);
    event CertificateRevoked(bytes32 indexed certHash, address indexed issuer, uint40 revokedAt);

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

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice True if the certificate exists and has not been revoked.
    /// @dev Does NOT depend on the issuer's current approval (see contract-level rules).
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

    /*//////////////////////////////////////////////////////////////
                                 INTERNAL
    //////////////////////////////////////////////////////////////*/

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
