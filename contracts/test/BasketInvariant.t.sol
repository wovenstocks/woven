// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {BasketToken} from "../src/BasketToken.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @dev Stateful actor limited to the two public value-moving basket actions.
contract BasketHandler is Test {
    BasketToken public immutable basket;
    MockERC20 public immutable tokenA;
    MockERC20 public immutable tokenB;

    constructor(BasketToken basket_, MockERC20 tokenA_, MockERC20 tokenB_) {
        basket = basket_;
        tokenA = tokenA_;
        tokenB = tokenB_;

        tokenA_.approve(address(basket_), type(uint256).max);
        tokenB_.approve(address(basket_), type(uint256).max);
    }

    function mint(uint96 rawAmount) external {
        uint256 room = basket.supplyCap() - basket.totalSupply();
        if (room == 0) return;

        uint256 amount = bound(uint256(rawAmount), 1, room);
        (, uint256[] memory required) = basket.getRequiredUnits(amount);
        tokenA.mint(address(this), required[0]);
        tokenB.mint(address(this), required[1]);
        basket.mint(amount, address(this));
    }

    function redeem(uint96 rawAmount) external {
        uint256 balance = basket.balanceOf(address(this));
        if (balance == 0) return;

        uint256 amount = bound(uint256(rawAmount), 1, balance);
        basket.redeem(amount, address(this));
    }
}

contract BasketInvariantTest is StdInvariant, Test {
    MockERC20 internal tokenA;
    MockERC20 internal tokenB;
    BasketToken internal basket;
    BasketHandler internal handler;

    function setUp() public {
        tokenA = new MockERC20("Asset A", "ASSETA");
        tokenB = new MockERC20("Asset B", "ASSETB");

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);

        uint256[] memory units = new uint256[](2);
        units[0] = 2e18;
        units[1] = 5e17;

        basket = new BasketToken(
            "Invariant Basket", "INVAR", tokens, units, 30, address(this), address(this), 1_000e18, 1_000e18
        );
        handler = new BasketHandler(basket, tokenA, tokenB);

        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = BasketHandler.mint.selector;
        selectors[1] = BasketHandler.redeem.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice Every outstanding basket unit remains covered by each constituent.
    function invariant_backingAlwaysCoversOutstandingSupply() public view {
        assertTrue(basket.isFullyBacked());

        (, uint256[] memory required) = basket.getRequiredUnits(basket.totalSupply());
        assertGe(tokenA.balanceOf(address(basket)), required[0]);
        assertGe(tokenB.balanceOf(address(basket)), required[1]);
    }

    /// @notice No sequence of public mint/redeem actions can exceed the immutable ceiling.
    function invariant_supplyNeverExceedsCap() public view {
        assertLe(basket.totalSupply(), basket.supplyCap());
        assertLe(basket.supplyCap(), basket.maxSupplyCap());
    }

    /// @notice Minting and redemption cannot mutate the fixed basket recipe.
    function invariant_recipeRemainsImmutable() public view {
        address[] memory tokens = basket.constituents();
        uint256[] memory units = basket.units();
        assertEq(tokens.length, 2);
        assertEq(tokens[0], address(tokenA));
        assertEq(tokens[1], address(tokenB));
        assertEq(units[0], 2e18);
        assertEq(units[1], 5e17);
    }
}
