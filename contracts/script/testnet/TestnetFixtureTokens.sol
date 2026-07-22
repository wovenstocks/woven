// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";

interface IScaledUIAmountFixture {
    function uiMultiplier() external view returns (uint256);
}

interface IScaledUIAmountConversionFixture {
    function toUIAmount(uint256 rawAmount) external view returns (uint256);
    function fromUIAmount(uint256 uiAmount) external view returns (uint256);
}

interface IScaledUIAmountPendingFixture {
    function newUIMultiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);
}

/// @notice Constructor guard shared by Woven's non-production fixture tokens.
/// @dev The bytecode cannot be deployed on BNB mainnet, even if a deployment
///      script is misconfigured. Local Anvil and BSC testnet are the only
///      permitted chains.
abstract contract TestnetFixtureChainGuard {
    error TestnetFixtureUnsupportedChain(uint256 chainId);
    error TestnetFixtureZeroRecipient();

    uint256 public constant BSC_TESTNET_CHAIN_ID = 97;
    uint256 public constant LOCAL_ANVIL_CHAIN_ID = 31_337;

    constructor() {
        uint256 chainId = block.chainid;
        if (chainId != BSC_TESTNET_CHAIN_ID && chainId != LOCAL_ANVIL_CHAIN_ID) {
            revert TestnetFixtureUnsupportedChain(chainId);
        }
    }

    /// @notice Explicit marker for explorers, clients, and release checks.
    function isTestnetFixture() external pure returns (bool) {
        return true;
    }
}

/// @notice Fixed-supply WOVEN-compatible token for local and BSC-testnet tests.
/// @dev Its metadata and Four.meme-shaped read methods intentionally satisfy
///      DeployCore's WOVEN validation. It is not a Four.meme token and can
///      never be deployed on BNB mainnet because of TestnetFixtureChainGuard.
contract WovenTestnetFixture is ERC20, TestnetFixtureChainGuard {
    uint256 public constant FIXTURE_SUPPLY = 1_000_000_000e18;

    constructor(address recipient) ERC20("Woven Stocks", "WOVEN") {
        if (recipient == address(0)) revert TestnetFixtureZeroRecipient();
        _mint(recipient, FIXTURE_SUPPLY);
    }

    function _mode() external pure returns (uint256) {
        return 0;
    }

    function owner() external pure returns (address) {
        return address(0);
    }
}

/// @notice Fixed-supply, identity-scaled ERC-8056 fixture for basket tests.
/// @dev Names include "TESTNET FIXTURE". Symbols match the intended bStock
///      catalog only so the real application mapping can be exercised. This
///      contract does not model issuer controls, custody, backing, or trading.
contract BStockTestnetFixture is
    ERC20,
    ERC165,
    TestnetFixtureChainGuard,
    IScaledUIAmountFixture,
    IScaledUIAmountConversionFixture,
    IScaledUIAmountPendingFixture
{
    uint256 public constant FIXTURE_SUPPLY = 1_000_000e18;
    uint256 public constant IDENTITY_UI_MULTIPLIER = 1e18;

    constructor(string memory name_, string memory symbol_, address recipient) ERC20(name_, symbol_) {
        if (recipient == address(0)) revert TestnetFixtureZeroRecipient();
        _mint(recipient, FIXTURE_SUPPLY);
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IScaledUIAmountFixture).interfaceId
            || interfaceId == type(IScaledUIAmountConversionFixture).interfaceId
            || interfaceId == type(IScaledUIAmountPendingFixture).interfaceId || super.supportsInterface(interfaceId);
    }

    function uiMultiplier() external pure returns (uint256) {
        return IDENTITY_UI_MULTIPLIER;
    }

    function newUIMultiplier() external pure returns (uint256) {
        return IDENTITY_UI_MULTIPLIER;
    }

    function effectiveAt() external pure returns (uint256) {
        return 0;
    }

    function toUIAmount(uint256 rawAmount) external pure returns (uint256) {
        return rawAmount;
    }

    function fromUIAmount(uint256 uiAmount) external pure returns (uint256) {
        return uiAmount;
    }
}
