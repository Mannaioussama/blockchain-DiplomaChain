// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IIssuerManager
/// @notice Minimal interface that CertificateRegistry needs from the IssuerManager contract.
/// @dev Agreed contract between the two team members:
///      - MUST be `view` (no state change).
///      - MUST NOT revert for unknown addresses: return `false` instead.
///      - MUST return `false` for an issuer that has been revoked/removed.
interface IIssuerManager {
    /// @param account Address to check.
    /// @return True if `account` is currently an approved (and not revoked) issuer.
    function isApprovedIssuer(address account) external view returns (bool);
}
