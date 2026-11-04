// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IIssuerManager} from "../interfaces/IIssuerManager.sol";

/// @title MockIssuerManager
/// @notice TEST ONLY. Stand-in for the partner's real IssuerManager until it is deployed.
/// @dev Do not use in production. The deployer is the only account allowed to change approvals.
contract MockIssuerManager is IIssuerManager {
    address public immutable deployer;
    mapping(address => bool) private _approved;

    error NotDeployer(address caller);

    event IssuerApprovalSet(address indexed account, bool approved);

    constructor() {
        deployer = msg.sender;
    }

    /// @notice Approve or revoke an issuer (mock of the real IssuerManager workflow).
    function setApproved(address account, bool approved) external {
        if (msg.sender != deployer) revert NotDeployer(msg.sender);
        _approved[account] = approved;
        emit IssuerApprovalSet(account, approved);
    }

    /// @inheritdoc IIssuerManager
    function isApprovedIssuer(address account) external view returns (bool) {
        return _approved[account];
    }
}
