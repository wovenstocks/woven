// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {BasketToken} from "../src/BasketToken.sol";
import {FeeOnTransferToken, MockERC20} from "./mocks/MockERC20.sol";

/// @dev Test-only token that taxes transfers only when a configured sender sends.
contract OutboundFeeToken is MockERC20 {
    address public taxedSender;

    constructor() MockERC20("Outbound Fee Asset", "OUTFEE") {}

    function setTaxedSender(address sender) external {
        taxedSender = sender;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from == taxedSender && to != address(0)) {
            uint256 fee = amount / 100;
            super._update(from, address(0), fee);
            super._update(from, to, amount - fee);
        } else {
            super._update(from, to, amount);
        }
    }
}

/// @dev Test-only model for a constituent seizure or negative balance adjustment.
contract SeizableToken is MockERC20 {
    constructor() MockERC20("Seizable Asset", "SEIZE") {}

    function seize(address account, uint256 amount) external {
        _burn(account, amount);
    }
}

contract TokenIntegrationTest is Test {
    address internal user = makeAddr("user");

    function _basket(address tokenA, address tokenB) internal returns (BasketToken) {
        address[] memory tokens = new address[](2);
        tokens[0] = tokenA;
        tokens[1] = tokenB;

        uint256[] memory units = new uint256[](2);
        units[0] = 1e18;
        units[1] = 1e18;

        return new BasketToken(
            "Integration Basket", "INTEGR", tokens, units, 0, address(this), address(this), 1_000e18, 1_000e18
        );
    }

    function _fundAndApprove(BasketToken basket, MockERC20 tokenA, MockERC20 tokenB, address account, uint256 amount)
        internal
    {
        tokenA.mint(account, amount);
        tokenB.mint(account, amount);
        vm.startPrank(account);
        tokenA.approve(address(basket), amount);
        tokenB.approve(address(basket), amount);
        vm.stopPrank();
    }

    function test_mintRejectsShortIncomingFeeOnTransferAsset() public {
        FeeOnTransferToken taxed = new FeeOnTransferToken();
        MockERC20 standard = new MockERC20("Standard Asset", "STD");
        BasketToken basket = _basket(address(taxed), address(standard));

        taxed.mint(user, 100e18);
        standard.mint(user, 100e18);
        vm.startPrank(user);
        taxed.approve(address(basket), type(uint256).max);
        standard.approve(address(basket), type(uint256).max);

        vm.expectRevert(abi.encodeWithSelector(BasketToken.InsufficientDeposit.selector, address(taxed)));
        basket.mint(100e18, user);
        vm.stopPrank();

        assertEq(basket.totalSupply(), 0);
        assertEq(taxed.balanceOf(address(basket)), 0);
    }

    function test_outboundFeeAssetRevertsRedemptionWithoutChangingState() public {
        OutboundFeeToken taxed = new OutboundFeeToken();
        MockERC20 standard = new MockERC20("Standard Asset", "STD");
        BasketToken basket = _basket(address(standard), address(taxed));
        taxed.setTaxedSender(address(basket));

        _fundAndApprove(basket, standard, taxed, user, 100e18);
        vm.prank(user);
        basket.mint(100e18, user);

        uint256 userBasketBefore = basket.balanceOf(user);
        uint256 taxedBackingBefore = taxed.balanceOf(address(basket));
        uint256 standardBackingBefore = standard.balanceOf(address(basket));
        vm.startPrank(user);
        vm.expectRevert(
            abi.encodeWithSelector(BasketToken.InexactRedemption.selector, address(taxed), 100e18, 100e18, 99e18)
        );
        basket.redeem(100e18, user);
        vm.stopPrank();

        assertEq(basket.balanceOf(user), userBasketBefore);
        assertEq(basket.totalSupply(), 100e18);
        assertEq(taxed.balanceOf(address(basket)), taxedBackingBefore);
        assertEq(standard.balanceOf(address(basket)), standardBackingBefore);
        assertEq(taxed.balanceOf(user), 0);
        assertEq(standard.balanceOf(user), 0);
    }

    function test_seizedBackingDeficitBlocksMintButNotAvailableRedemption() public {
        SeizableToken seized = new SeizableToken();
        MockERC20 standard = new MockERC20("Standard Asset", "STD");
        BasketToken basket = _basket(address(seized), address(standard));

        _fundAndApprove(basket, seized, standard, user, 100e18);
        vm.prank(user);
        basket.mint(100e18, user);
        seized.seize(address(basket), 1e18);
        assertFalse(basket.isFullyBacked());

        _fundAndApprove(basket, seized, standard, user, 10e18);
        uint256 seizedInputBefore = seized.balanceOf(user);
        uint256 standardInputBefore = standard.balanceOf(user);
        vm.startPrank(user);
        vm.expectRevert(
            abi.encodeWithSelector(BasketToken.ExistingBackingDeficit.selector, address(seized), 99e18, 100e18)
        );
        basket.mint(10e18, user);
        vm.stopPrank();

        assertEq(basket.totalSupply(), 100e18);
        assertEq(seized.balanceOf(user), seizedInputBefore);
        assertEq(standard.balanceOf(user), standardInputBefore);

        vm.prank(user);
        basket.redeem(1e18, user);
        assertEq(basket.totalSupply(), 99e18);
        assertEq(seized.balanceOf(user), seizedInputBefore + 1e18);
        assertEq(standard.balanceOf(user), standardInputBefore + 1e18);
    }

    function test_fullyAndOverBackedBasketsCanMint() public {
        MockERC20 tokenA = new MockERC20("Asset A", "ASSETA");
        MockERC20 tokenB = new MockERC20("Asset B", "ASSETB");
        BasketToken basket = _basket(address(tokenA), address(tokenB));

        _fundAndApprove(basket, tokenA, tokenB, user, 10e18);
        vm.prank(user);
        basket.mint(10e18, user);

        _fundAndApprove(basket, tokenA, tokenB, user, 1e18);
        vm.prank(user);
        basket.mint(1e18, user);
        assertTrue(basket.isFullyBacked());

        tokenA.mint(address(basket), 5e18);
        tokenB.mint(address(basket), 2e18);
        _fundAndApprove(basket, tokenA, tokenB, user, 1e18);
        vm.prank(user);
        basket.mint(1e18, user);

        assertEq(basket.totalSupply(), 12e18);
        assertTrue(basket.isFullyBacked());
    }

    function test_redeemRejectsBasketAsRecipientWithoutBurning() public {
        MockERC20 tokenA = new MockERC20("Asset A", "ASSETA");
        MockERC20 tokenB = new MockERC20("Asset B", "ASSETB");
        BasketToken basket = _basket(address(tokenA), address(tokenB));

        _fundAndApprove(basket, tokenA, tokenB, user, 10e18);
        vm.prank(user);
        basket.mint(10e18, user);

        vm.prank(user);
        vm.expectRevert(BasketToken.InvalidRedemptionRecipient.selector);
        basket.redeem(1e18, address(basket));

        assertEq(basket.balanceOf(user), 10e18);
        assertEq(basket.totalSupply(), 10e18);
    }

    function test_redeemRejectsZeroRoundedConstituentWithoutBurning() public {
        MockERC20 tokenA = new MockERC20("Low Unit Asset", "LOW");
        MockERC20 tokenB = new MockERC20("Standard Asset", "STD");

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        uint256[] memory units = new uint256[](2);
        units[0] = 1;
        units[1] = 1e18;

        BasketToken basket = new BasketToken(
            "Rounding Basket", "ROUND", tokens, units, 0, address(this), address(this), 1_000e18, 1_000e18
        );

        tokenA.mint(user, 1);
        tokenB.mint(user, 1);
        vm.startPrank(user);
        tokenA.approve(address(basket), 1);
        tokenB.approve(address(basket), 1);
        basket.mint(1, user);

        vm.expectRevert(abi.encodeWithSelector(BasketToken.ZeroRedemptionOutput.selector, address(tokenA)));
        basket.redeem(1, user);
        vm.stopPrank();

        assertEq(basket.balanceOf(user), 1);
        assertEq(basket.totalSupply(), 1);
        assertEq(tokenA.balanceOf(address(basket)), 1);
        assertEq(tokenB.balanceOf(address(basket)), 1);
    }

    function testFuzz_existingBackingDeficitBlocksFurtherMint(uint96 rawDeficit, uint96 rawMintAmount) public {
        SeizableToken seized = new SeizableToken();
        MockERC20 standard = new MockERC20("Standard Asset", "STD");
        BasketToken basket = _basket(address(seized), address(standard));
        uint256 initialAmount = 100e18;
        uint256 deficit = bound(uint256(rawDeficit), 1, 99e18);
        uint256 mintAmount = bound(uint256(rawMintAmount), 1, 100e18);

        _fundAndApprove(basket, seized, standard, user, initialAmount);
        vm.prank(user);
        basket.mint(initialAmount, user);
        seized.seize(address(basket), deficit);
        _fundAndApprove(basket, seized, standard, user, mintAmount);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                BasketToken.ExistingBackingDeficit.selector, address(seized), initialAmount - deficit, initialAmount
            )
        );
        basket.mint(mintAmount, user);

        assertEq(basket.totalSupply(), initialAmount);
    }
}
