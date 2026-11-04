// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IIssuerManager} from "../interfaces/IIssuerManager.sol";

/// @title MockRevertingIssuerManager
/// @notice TEST ONLY. An IssuerManager that can be switched "offline", in which case
///         `isApprovedIssuer` reverts. Used to check that CertificateRegistry behaves safely
///         when its IssuerManager misbehaves. Never deployed outside the test suite.
contract MockRevertingIssuerManager is IIssuerManager {
    mapping(address => bool) private _approved;
    bool public offline;

    error ManagerOffline();

    function setApproved(address account, bool approved) external {
        _approved[account] = approved;
    }

    function setOffline(bool value) external {
        offline = value;
    }

    /// @inheritdoc IIssuerManager
    function isApprovedIssuer(address account) external view returns (bool) {
        if (offline) revert ManagerOffline();
        return _approved[account];
    }
}
