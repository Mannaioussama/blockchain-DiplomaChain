// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IIssuerManager} from "./interfaces/IIssuerManager.sol";

/// @title IssuerManager
/// @notice Consortium of accredited institutions allowed to issue diplomas in CertificateRegistry.
///         There is NO admin: member institutions vote to admit new institutions and to remove
///         existing ones.
/// @dev Rules:
///      - Founding members are set once in the constructor. After deployment nobody has special
///        powers; every change goes through a vote.
///      - Any non-member can apply (`applyToJoin`). Members vote; a strict majority of eligible
///        voters decides, and the proposal closes automatically on the deciding vote.
///      - Any member can propose removing another member. The target cannot vote on its own
///        removal, so eligible voters = members - 1. A member can also leave voluntarily, unless it
///        is the last member.
///      - The majority is computed from the CURRENT member count. A vote already cast by a member
///        who later leaves or is removed still counts (recounting would need a loop). If the member
///        count changes while a proposal is open, anyone can call `finalize` to close it once the
///        outcome is decided.
///      - `isApprovedIssuer` is `view` and returns false (never reverts) for unknown, pending,
///        rejected, removed or departed addresses.
contract IssuerManager is IIssuerManager {
    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @dev None = 0 so an unknown address is distinguishable from a known one.
    enum InstitutionStatus {
        None,
        Pending,
        Approved,
        Rejected,
        Removed,
        Left
    }

    enum ProposalKind {
        Admission,
        Removal
    }

    enum ProposalStatus {
        None,
        Open,
        Approved,
        Rejected,
        Cancelled
    }

    struct Institution {
        string name;
        InstitutionStatus status;
        uint40 updatedAt;
    }

    /// @dev Packed in two storage slots: (20 + 1 + 1 + 5 + 5) and (20 + 4 + 4) bytes.
    struct Proposal {
        address target;
        ProposalKind kind;
        ProposalStatus status;
        uint40 createdAt;
        uint40 closedAt;
        address proposer;
        uint32 yesVotes;
        uint32 noVotes;
    }

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    uint256 public constant MAX_FOUNDERS = 10;
    uint256 public constant MAX_NAME_LENGTH = 64;

    mapping(address account => Institution) private _institutions;

    /// @dev Current members, with O(1) removal (swap-and-pop) through a 1-based index.
    address[] private _members;
    mapping(address member => uint256 indexPlusOne) private _memberIndex;

    /// @notice Number of proposals ever created. Proposal ids start at 1.
    uint256 public proposalCount;
    mapping(uint256 proposalId => Proposal) private _proposals;
    mapping(uint256 proposalId => mapping(address voter => bool)) private _hasVoted;

    /// @notice Open proposal (admission or removal) about an address, 0 if none.
    mapping(address target => uint256 proposalId) public openProposalOf;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event InstitutionApproved(address indexed institution, string name);
    event InstitutionApplied(address indexed applicant, uint256 indexed proposalId, string name);
    event RemovalProposed(uint256 indexed proposalId, address indexed target, address indexed proposer);
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support);
    event ProposalClosed(uint256 indexed proposalId, ProposalStatus status);
    event InstitutionRemoved(address indexed institution);
    event InstitutionLeft(address indexed institution);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error NoFounders();
    error TooManyFounders(uint256 count);
    error LengthMismatch();
    error InvalidAddress();
    error DuplicateFounder(address founder);
    error InvalidName();
    error NotMember(address caller);
    error AlreadyMember(address account);
    error OpenProposalExists(address target, uint256 proposalId);
    error NoOpenApplication(address applicant);
    error ProposalNotOpen(uint256 proposalId);
    error AlreadyVoted(uint256 proposalId, address voter);
    error CannotVoteOnOwnRemoval();
    error CannotProposeOwnRemoval();
    error LastMember();

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param founders Wallets of the founding institutions (1 to MAX_FOUNDERS, no duplicates).
    /// @param names    Public names of the founding institutions, same order as `founders`.
    constructor(address[] memory founders, string[] memory names) {
        uint256 count = founders.length;
        if (count == 0) revert NoFounders();
        if (count > MAX_FOUNDERS) revert TooManyFounders(count);
        if (names.length != count) revert LengthMismatch();

        for (uint256 i = 0; i < count; ++i) {
            address founder = founders[i];
            if (founder == address(0)) revert InvalidAddress();
            if (_institutions[founder].status == InstitutionStatus.Approved) {
                revert DuplicateFounder(founder);
            }
            _validateName(names[i]);
            _institutions[founder].name = names[i];
            _addMember(founder);
        }
    }

    /*//////////////////////////////////////////////////////////////
                               MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyMember() {
        if (_institutions[msg.sender].status != InstitutionStatus.Approved) revert NotMember(msg.sender);
        _;
    }

    /*//////////////////////////////////////////////////////////////
                              STATE-CHANGING
    //////////////////////////////////////////////////////////////*/

    /// @notice Ask to join the consortium. Opens an admission proposal for the caller.
    /// @param name Public institution name (1 to MAX_NAME_LENGTH bytes).
    function applyToJoin(string calldata name) external returns (uint256 proposalId) {
        Institution storage inst = _institutions[msg.sender];
        if (inst.status == InstitutionStatus.Approved) revert AlreadyMember(msg.sender);
        uint256 open = openProposalOf[msg.sender];
        if (open != 0) revert OpenProposalExists(msg.sender, open);
        _validateName(name);

        inst.name = name;
        inst.status = InstitutionStatus.Pending;
        inst.updatedAt = uint40(block.timestamp);

        proposalId = _createProposal(ProposalKind.Admission, msg.sender);
        emit InstitutionApplied(msg.sender, proposalId, name);
    }

    /// @notice Withdraw the caller's pending application.
    function withdrawApplication() external {
        uint256 proposalId = openProposalOf[msg.sender];
        if (proposalId == 0 || _proposals[proposalId].kind != ProposalKind.Admission) {
            revert NoOpenApplication(msg.sender);
        }
        Institution storage inst = _institutions[msg.sender];
        inst.status = InstitutionStatus.None;
        inst.updatedAt = uint40(block.timestamp);
        _close(proposalId, ProposalStatus.Cancelled);
    }

    /// @notice Propose removing another member. Use `leave` to remove yourself.
    function proposeRemoval(address target) external onlyMember returns (uint256 proposalId) {
        if (target == msg.sender) revert CannotProposeOwnRemoval();
        if (_institutions[target].status != InstitutionStatus.Approved) revert NotMember(target);
        uint256 open = openProposalOf[target];
        if (open != 0) revert OpenProposalExists(target, open);

        proposalId = _createProposal(ProposalKind.Removal, target);
        emit RemovalProposed(proposalId, target, msg.sender);
    }

    /// @notice Vote on an open proposal. Closes it automatically when the outcome is decided.
    function vote(uint256 proposalId, bool support) external onlyMember {
        Proposal storage p = _proposals[proposalId];
        if (p.status != ProposalStatus.Open) revert ProposalNotOpen(proposalId);
        if (p.kind == ProposalKind.Removal && p.target == msg.sender) revert CannotVoteOnOwnRemoval();
        if (_hasVoted[proposalId][msg.sender]) revert AlreadyVoted(proposalId, msg.sender);

        _hasVoted[proposalId][msg.sender] = true;
        if (support) {
            ++p.yesVotes;
        } else {
            ++p.noVotes;
        }
        emit VoteCast(proposalId, msg.sender, support);

        _closeIfDecided(proposalId, p);
    }

    /// @notice Close an open proposal whose outcome became decided after the member count changed.
    /// @dev Anyone can call it; it does nothing if the outcome is still undecided.
    function finalize(uint256 proposalId) external {
        Proposal storage p = _proposals[proposalId];
        if (p.status != ProposalStatus.Open) revert ProposalNotOpen(proposalId);
        _closeIfDecided(proposalId, p);
    }

    /// @notice Leave the consortium voluntarily. The last member cannot leave.
    /// @dev Like a removal: the institution can no longer issue, but its diplomas stay valid.
    function leave() external onlyMember {
        if (_members.length == 1) revert LastMember();
        _removeMember(msg.sender, InstitutionStatus.Left);

        uint256 open = openProposalOf[msg.sender];
        if (open != 0) _close(open, ProposalStatus.Cancelled);

        emit InstitutionLeft(msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IIssuerManager
    function isApprovedIssuer(address account) external view returns (bool) {
        return _institutions[account].status == InstitutionStatus.Approved;
    }

    function getInstitution(address account)
        external
        view
        returns (string memory name, InstitutionStatus status, uint40 updatedAt)
    {
        Institution storage inst = _institutions[account];
        return (inst.name, inst.status, inst.updatedAt);
    }

    function getProposal(uint256 proposalId) external view returns (Proposal memory) {
        return _proposals[proposalId];
    }

    function hasVoted(uint256 proposalId, address voter) external view returns (bool) {
        return _hasVoted[proposalId][voter];
    }

    function memberCount() external view returns (uint256) {
        return _members.length;
    }

    /// @dev For the UI. Bounded by the number of members.
    function getMembers() external view returns (address[] memory) {
        return _members;
    }

    /// @notice Yes votes needed to approve a proposal, with the current member count.
    function requiredVotes(uint256 proposalId) external view returns (uint256) {
        (, uint256 required) = _thresholds(_proposals[proposalId]);
        return required;
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _createProposal(ProposalKind kind, address target) private returns (uint256 proposalId) {
        proposalId = ++proposalCount;
        _proposals[proposalId] = Proposal({
            target: target,
            kind: kind,
            status: ProposalStatus.Open,
            createdAt: uint40(block.timestamp),
            closedAt: 0,
            proposer: msg.sender,
            yesVotes: 0,
            noVotes: 0
        });
        openProposalOf[target] = proposalId;
    }

    /// @return eligible Members allowed to vote on `p`.
    /// @return required Strict majority of `eligible`.
    function _thresholds(Proposal storage p) private view returns (uint256 eligible, uint256 required) {
        eligible = _members.length;
        if (p.kind == ProposalKind.Removal) eligible -= 1;
        required = eligible / 2 + 1;
    }

    function _closeIfDecided(uint256 proposalId, Proposal storage p) private {
        (uint256 eligible, uint256 required) = _thresholds(p);

        if (p.yesVotes >= required) {
            _close(proposalId, ProposalStatus.Approved);
            if (p.kind == ProposalKind.Admission) {
                _addMember(p.target);
            } else {
                _removeMember(p.target, InstitutionStatus.Removed);
                emit InstitutionRemoved(p.target);
            }
        } else if (p.noVotes + required > eligible) {
            // Not enough voters left for the yes side to reach the majority.
            _close(proposalId, ProposalStatus.Rejected);
            if (p.kind == ProposalKind.Admission) {
                Institution storage inst = _institutions[p.target];
                inst.status = InstitutionStatus.Rejected;
                inst.updatedAt = uint40(block.timestamp);
            }
        }
    }

    function _close(uint256 proposalId, ProposalStatus status) private {
        Proposal storage p = _proposals[proposalId];
        p.status = status;
        p.closedAt = uint40(block.timestamp);
        openProposalOf[p.target] = 0;
        emit ProposalClosed(proposalId, status);
    }

    function _addMember(address account) private {
        Institution storage inst = _institutions[account];
        inst.status = InstitutionStatus.Approved;
        inst.updatedAt = uint40(block.timestamp);
        _members.push(account);
        _memberIndex[account] = _members.length;
        emit InstitutionApproved(account, inst.name);
    }

    function _removeMember(address account, InstitutionStatus newStatus) private {
        uint256 index = _memberIndex[account] - 1;
        address last = _members[_members.length - 1];
        _members[index] = last;
        _memberIndex[last] = index + 1;
        _members.pop();
        delete _memberIndex[account];

        Institution storage inst = _institutions[account];
        inst.status = newStatus;
        inst.updatedAt = uint40(block.timestamp);
    }

    function _validateName(string memory name) private pure {
        uint256 length = bytes(name).length;
        if (length == 0 || length > MAX_NAME_LENGTH) revert InvalidName();
    }
}
