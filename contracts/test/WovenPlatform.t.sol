// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {BasketToken} from "../src/BasketToken.sol";
import {BasketFactory, ICreatorLicense, ICanonicalAssetRegistry} from "../src/BasketFactory.sol";
import {CanonicalAssetRegistry} from "../src/CanonicalAssetRegistry.sol";
import {CreatorLicense} from "../src/CreatorLicense.sol";
import {CuratorGuardian, IBasketCap, IBasketMintPause} from "../src/CuratorGuardian.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";
import {MockERC20, FeeOnTransferToken} from "./mocks/MockERC20.sol";

contract NoOpManagedBasket {
    address public immutable guardian;
    uint256 public supplyCap = 1;
    bool public mintPaused;

    constructor(address guardian_) {
        guardian = guardian_;
    }

    function setSupplyCap(uint256) external {}

    function setMintPaused(bool) external {}
}

/// @notice End-to-end tests for the Woven protocol core.
contract WovenPlatformTest is Test {
    event MintPauseSet(address indexed basket, bool paused);

    uint256 internal constant LICENSE_AMOUNT = 10_000e18;
    address internal constant BURN_SINK = 0x000000000000000000000000000000000000dEaD;

    address internal creator = makeAddr("creator");
    address internal minter = makeAddr("minter");
    address internal protocolSafe = makeAddr("protocolSafe");
    address internal treasury = makeAddr("treasury");

    MockERC20 internal wovenToken;
    MockERC20 internal nvidia;
    MockERC20 internal microsoft;
    MockERC20 internal fakeStock;
    CreatorLicense internal creatorLicense;
    CanonicalAssetRegistry internal assetRegistry;
    FeeSplitter internal splitter;
    CuratorGuardian internal guardian;
    BasketFactory internal factory;

    function setUp() public {
        wovenToken = new MockERC20("Woven", "WOVEN");
        nvidia = new MockERC20("NVIDIA bStock", "NVDAB");
        microsoft = new MockERC20("Microsoft bStock", "MSFTB");
        fakeStock = new MockERC20("Fake bStock", "FAKEB");

        creatorLicense = new CreatorLicense(IERC20(address(wovenToken)));
        assetRegistry = new CanonicalAssetRegistry(protocolSafe);
        splitter = new FeeSplitter(treasury);
        guardian = new CuratorGuardian(protocolSafe);
        factory = new BasketFactory(
            ICreatorLicense(address(creatorLicense)),
            ICanonicalAssetRegistry(address(assetRegistry)),
            splitter,
            address(guardian)
        );
        splitter.initFactory(address(factory));

        address[] memory canonical = new address[](2);
        canonical[0] = address(nvidia);
        canonical[1] = address(microsoft);
        vm.prank(protocolSafe);
        assetRegistry.setAssets(canonical, true);

        wovenToken.mint(creator, 100_000e18);
    }

    function _unlock(address account) internal {
        vm.startPrank(account);
        wovenToken.approve(address(creatorLicense), LICENSE_AMOUNT);
        creatorLicense.burnForLicense();
        vm.stopPrank();
    }

    function _create(address account) internal returns (BasketToken basket) {
        address[] memory tokens = new address[](2);
        tokens[0] = address(nvidia);
        tokens[1] = address(microsoft);
        uint256[] memory units = new uint256[](2);
        units[0] = 2e18;
        units[1] = 5e17;

        vm.prank(account);
        basket = BasketToken(factory.createBasket("BNB Tech Two", "TECH2", tokens, units, 30, 1_000e18));
    }

    function _fundAndApprove(BasketToken basket, address account, uint256 amount) internal {
        (, uint256[] memory required) = basket.getRequiredUnits(amount);
        nvidia.mint(account, required[0]);
        microsoft.mint(account, required[1]);
        vm.startPrank(account);
        nvidia.approve(address(basket), required[0]);
        microsoft.approve(address(basket), required[1]);
        vm.stopPrank();
    }

    function test_licenseMovesExactWovenAmountOutOfCirculation() public {
        _unlock(creator);

        assertTrue(creatorLicense.isLicensed(creator));
        assertEq(creatorLicense.LICENSE_BURN_AMOUNT(), LICENSE_AMOUNT);
        assertEq(creatorLicense.BURN_SINK(), BURN_SINK);
        assertEq(wovenToken.balanceOf(BURN_SINK), LICENSE_AMOUNT);
        assertEq(wovenToken.balanceOf(creator), 90_000e18);
        assertEq(wovenToken.totalSupply(), 100_000e18);
    }

    function test_licenseCannotBePurchasedTwice() public {
        _unlock(creator);
        vm.startPrank(creator);
        wovenToken.approve(address(creatorLicense), LICENSE_AMOUNT);
        vm.expectRevert(CreatorLicense.AlreadyLicensed.selector);
        creatorLicense.burnForLicense();
        vm.stopPrank();
    }

    function test_licenseRejectsFeeOnTransferWovenToken() public {
        FeeOnTransferToken taxedWoven = new FeeOnTransferToken();
        CreatorLicense taxedLicense = new CreatorLicense(IERC20(address(taxedWoven)));
        taxedWoven.mint(creator, LICENSE_AMOUNT);

        vm.startPrank(creator);
        taxedWoven.approve(address(taxedLicense), LICENSE_AMOUNT);
        vm.expectRevert(CreatorLicense.UnsupportedWovenToken.selector);
        taxedLicense.burnForLicense();
        vm.stopPrank();

        assertFalse(taxedLicense.isLicensed(creator));
        assertEq(taxedWoven.balanceOf(creator), LICENSE_AMOUNT);
    }

    function test_oneLicenseUnlocksMultipleFixedBaskets() public {
        _unlock(creator);

        _create(creator);
        _create(creator);

        assertEq(factory.basketCount(), 2);
        assertEq(wovenToken.balanceOf(BURN_SINK), LICENSE_AMOUNT);
    }

    function test_factoryPaginatesBasketIndexWithinBound() public {
        _unlock(creator);

        BasketToken first = _create(creator);
        BasketToken second = _create(creator);
        BasketToken third = _create(creator);

        address[] memory firstPage = factory.basketsPage(0, 2);
        assertEq(firstPage.length, 2);
        assertEq(firstPage[0], address(first));
        assertEq(firstPage[1], address(second));

        address[] memory finalPage = factory.basketsPage(2, 2);
        assertEq(finalPage.length, 1);
        assertEq(finalPage[0], address(third));
        assertEq(factory.basketsPage(3, 2).length, 0);
        assertEq(factory.basketsPage(0, 0).length, 0);

        uint256 maximum = factory.MAX_PAGE_SIZE();
        vm.expectRevert(abi.encodeWithSelector(BasketFactory.PageSizeTooLarge.selector, maximum + 1, maximum));
        factory.basketsPage(0, maximum + 1);
    }

    function test_unlicensedCreatorCannotPublish() public {
        vm.expectRevert(BasketFactory.NotLicensed.selector);
        _create(creator);
    }

    function test_factoryRejectsNonCanonicalAsset() public {
        _unlock(creator);
        address[] memory tokens = new address[](2);
        tokens[0] = address(nvidia);
        tokens[1] = address(fakeStock);
        uint256[] memory units = new uint256[](2);
        units[0] = 1e18;
        units[1] = 1e18;

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BasketFactory.UnsupportedAsset.selector, address(fakeStock)));
        factory.createBasket("Fake", "FAKE", tokens, units, 30, 1_000e18);
    }

    function test_onlyRegistryOwnerCanWhitelist() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, creator));
        assetRegistry.setAsset(address(fakeStock), true);

        vm.prank(protocolSafe);
        assetRegistry.setAsset(address(fakeStock), true);
        assertTrue(assetRegistry.isSupported(address(fakeStock)));
    }

    function test_registryOwnershipCannotBeRenounced() public {
        vm.prank(protocolSafe);
        vm.expectRevert(CanonicalAssetRegistry.OwnershipRenunciationDisabled.selector);
        assetRegistry.renounceOwnership();

        assertEq(assetRegistry.owner(), protocolSafe);
    }

    function test_createMintDistributeAndRedeem() public {
        _unlock(creator);
        BasketToken basket = _create(creator);

        assertEq(factory.creatorOf(address(basket)), creator);
        assertEq(basket.guardian(), address(guardian));
        assertEq(basket.feeRecipient(), address(splitter));
        assertEq(factory.basketCount(), 1);

        uint256 gross = 100e18;
        _fundAndApprove(basket, minter, gross);
        vm.prank(minter);
        basket.mint(gross, minter);

        uint256 fee = (gross * 30) / 10_000;
        uint256 userAmount = gross - fee;
        assertEq(basket.balanceOf(minter), userAmount);
        assertEq(basket.balanceOf(address(splitter)), fee);
        assertTrue(basket.isFullyBacked());

        splitter.distribute(address(basket));
        assertEq(basket.balanceOf(creator), (fee * 6_000) / 10_000);
        assertEq(basket.balanceOf(treasury), fee - ((fee * 6_000) / 10_000));

        vm.prank(protocolSafe);
        vm.expectRevert(BasketToken.NotGuardian.selector);
        basket.setMintPaused(true);

        uint256 nvidiaBefore = nvidia.balanceOf(minter);
        uint256 microsoftBefore = microsoft.balanceOf(minter);
        vm.prank(minter);
        basket.redeem(userAmount, minter);

        assertEq(nvidia.balanceOf(minter) - nvidiaBefore, (userAmount * 2e18) / 1e18);
        assertEq(microsoft.balanceOf(minter) - microsoftBefore, (userAmount * 5e17) / 1e18);
        assertTrue(basket.isFullyBacked());
    }

    function test_guardianCanRaiseCapWithinCeiling() public {
        _unlock(creator);
        BasketToken basket = _create(creator);

        vm.prank(protocolSafe);
        guardian.raiseCap(IBasketCap(address(basket)), 2_000e18);
        assertEq(basket.supplyCap(), 2_000e18);

        vm.prank(protocolSafe);
        vm.expectRevert(CuratorGuardian.CapNotIncreasing.selector);
        guardian.raiseCap(IBasketCap(address(basket)), 1_500e18);

        vm.prank(creator);
        vm.expectRevert(CuratorGuardian.NotAdmin.selector);
        guardian.raiseCap(IBasketCap(address(basket)), 3_000e18);
    }

    function test_guardianAdminCanPauseMintingWithoutBlockingRedemption() public {
        _unlock(creator);
        BasketToken basket = _create(creator);

        uint256 gross = 10e18;
        _fundAndApprove(basket, minter, gross);
        vm.prank(minter);
        basket.mint(gross, minter);

        vm.prank(creator);
        vm.expectRevert(CuratorGuardian.NotAdmin.selector);
        guardian.setMintPaused(IBasketMintPause(address(basket)), true);

        vm.prank(protocolSafe);
        vm.expectEmit(true, false, false, true, address(guardian));
        emit MintPauseSet(address(basket), true);
        guardian.setMintPaused(IBasketMintPause(address(basket)), true);
        assertTrue(basket.mintPaused());

        vm.prank(minter);
        vm.expectRevert(BasketToken.MintingPaused.selector);
        basket.mint(1e18, minter);

        uint256 redeemable = basket.balanceOf(minter);
        vm.prank(minter);
        basket.redeem(redeemable, minter);
        assertTrue(basket.isFullyBacked());

        vm.prank(protocolSafe);
        vm.expectEmit(true, false, false, true, address(guardian));
        emit MintPauseSet(address(basket), false);
        guardian.setMintPaused(IBasketMintPause(address(basket)), false);
        assertFalse(basket.mintPaused());

        _fundAndApprove(basket, minter, 1e18);
        vm.prank(minter);
        basket.mint(1e18, minter);
    }

    function test_feeRecipientIsConstructorBoundAndHasNoSetter() public {
        _unlock(creator);
        BasketToken basket = _create(creator);

        assertEq(basket.feeRecipient(), address(splitter));
        vm.prank(protocolSafe);
        (bool success,) = address(basket).call(abi.encodeWithSignature("setFeeRecipient(address)", treasury));

        assertFalse(success);
        assertEq(basket.feeRecipient(), address(splitter));
    }

    function test_guardianCannotPauseBasketThatDidNotAuthorizeIt() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(nvidia);
        tokens[1] = address(microsoft);
        uint256[] memory units = new uint256[](2);
        units[0] = 2e18;
        units[1] = 5e17;
        BasketToken unmanaged = new BasketToken(
            "Unmanaged Basket", "UNMAN", tokens, units, 30, address(splitter), creator, 1_000e18, 1_000e18
        );

        vm.prank(protocolSafe);
        vm.expectRevert(CuratorGuardian.UnmanagedBasket.selector);
        guardian.setMintPaused(IBasketMintPause(address(unmanaged)), true);

        assertFalse(unmanaged.mintPaused());
    }

    function test_guardianRejectsEmptyPauseTargetsWithoutEmittingSuccess() public {
        vm.startPrank(protocolSafe);

        vm.expectRevert(CuratorGuardian.InvalidBasket.selector);
        guardian.setMintPaused(IBasketMintPause(address(0)), true);

        vm.expectRevert(CuratorGuardian.InvalidBasket.selector);
        guardian.setMintPaused(IBasketMintPause(makeAddr("emptyTarget")), true);

        vm.expectRevert(CuratorGuardian.InvalidBasket.selector);
        guardian.raiseCap(IBasketCap(makeAddr("emptyCapTarget")), 2);

        vm.stopPrank();
    }

    function test_guardianVerifiesForwardedStateChange() public {
        NoOpManagedBasket noOp = new NoOpManagedBasket(address(guardian));

        vm.prank(protocolSafe);
        vm.expectRevert(CuratorGuardian.PauseStateMismatch.selector);
        guardian.setMintPaused(IBasketMintPause(address(noOp)), true);

        vm.prank(protocolSafe);
        vm.expectRevert(CuratorGuardian.CapStateMismatch.selector);
        guardian.raiseCap(IBasketCap(address(noOp)), 2);
    }

    function testFuzz_mintRedeemPreservesBacking(uint96 rawAmount) public {
        _unlock(creator);
        BasketToken basket = _create(creator);
        uint256 amount = bound(uint256(rawAmount), 1e6, 999e18);
        _fundAndApprove(basket, minter, amount);

        vm.prank(minter);
        basket.mint(amount, minter);
        assertTrue(basket.isFullyBacked());

        uint256 userAmount = basket.balanceOf(minter);
        vm.prank(minter);
        basket.redeem(userAmount, minter);
        assertTrue(basket.isFullyBacked());
    }
}
