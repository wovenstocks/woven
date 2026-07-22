// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title FeeSplitter — immutable 60/40 basket-fee routing
/// @dev Adapted from Vimen's MIT-licensed FeeSplitter.
contract FeeSplitter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error AlreadyInitialized();
    error NotDeployer();
    error NotFactory();
    error UnknownBasket();

    event BasketRegistered(address indexed basket, address indexed creator);
    event Distributed(address indexed basket, address indexed creator, uint256 toCreator, uint256 toTreasury);

    uint256 public constant CREATOR_SHARE_BPS = 6_000;

    address public immutable treasury;
    address private immutable _deployer;
    address public factory;

    mapping(address basket => address creator) public creatorOf;

    constructor(address treasury_) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        _deployer = msg.sender;
    }

    function initFactory(address factory_) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (factory != address(0)) revert AlreadyInitialized();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
    }

    function register(address basket, address creator) external {
        if (msg.sender != factory) revert NotFactory();
        if (basket == address(0) || creator == address(0)) revert ZeroAddress();
        creatorOf[basket] = creator;
        emit BasketRegistered(basket, creator);
    }

    function distribute(address basket) external nonReentrant {
        address creator = creatorOf[basket];
        if (creator == address(0)) revert UnknownBasket();

        uint256 balance = IERC20(basket).balanceOf(address(this));
        // Exact equality is the intended ERC-20 empty-balance guard.
        // slither-disable-next-line incorrect-equality
        if (balance == 0) return;

        uint256 toCreator = (balance * CREATOR_SHARE_BPS) / 10_000;
        uint256 toTreasury = balance - toCreator;
        if (toCreator > 0) IERC20(basket).safeTransfer(creator, toCreator);
        if (toTreasury > 0) IERC20(basket).safeTransfer(treasury, toTreasury);

        emit Distributed(basket, creator, toCreator, toTreasury);
    }
}
