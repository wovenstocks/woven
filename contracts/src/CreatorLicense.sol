// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title CreatorLicense — permanent basket-publishing access paid in WOVEN
/// @notice Moves 10,000 WOVEN to an immutable burn sink. One successful
///         payment grants permanent access to publish multiple fixed baskets.
/// @dev A Four.meme token is not assumed to expose burnFrom(). Moving tokens to
///      a dead sink removes them from circulation without reducing totalSupply().
///      Exact sink accounting rejects fee-on-transfer or rebasing WOVEN tokens.
contract CreatorLicense is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error AlreadyLicensed();
    error UnsupportedWovenToken();

    /// @dev "Burned" means transferred to `BURN_SINK`; ERC-20 totalSupply is unchanged.
    event LicenseBurned(address indexed creator, uint256 amount, address indexed burnSink);

    uint256 public constant LICENSE_BURN_AMOUNT = 10_000e18;
    address public constant BURN_SINK = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable wovenToken;

    mapping(address creator => bool) private _licensed;

    constructor(IERC20 wovenToken_) {
        if (address(wovenToken_) == address(0)) revert ZeroAddress();
        if (address(wovenToken_).code.length == 0) revert UnsupportedWovenToken();

        wovenToken = wovenToken_;
    }

    function burnForLicense() external nonReentrant {
        if (_licensed[msg.sender]) revert AlreadyLicensed();

        uint256 sinkBefore = wovenToken.balanceOf(BURN_SINK);
        _licensed[msg.sender] = true;
        wovenToken.safeTransferFrom(msg.sender, BURN_SINK, LICENSE_BURN_AMOUNT);
        uint256 sinkAfter = wovenToken.balanceOf(BURN_SINK);
        if (sinkAfter < sinkBefore || sinkAfter - sinkBefore != LICENSE_BURN_AMOUNT) {
            revert UnsupportedWovenToken();
        }

        emit LicenseBurned(msg.sender, LICENSE_BURN_AMOUNT, BURN_SINK);
    }

    function isLicensed(address creator) external view returns (bool) {
        return _licensed[creator];
    }
}
