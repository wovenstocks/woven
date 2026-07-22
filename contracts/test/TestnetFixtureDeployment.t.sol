// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DeployCore} from "../script/DeployCore.s.sol";
import {DeployTestnetFixtures} from "../script/testnet/DeployTestnetFixtures.s.sol";
import {
    BStockTestnetFixture,
    IScaledUIAmountConversionFixture,
    IScaledUIAmountFixture,
    IScaledUIAmountPendingFixture,
    TestnetFixtureChainGuard,
    WovenTestnetFixture
} from "../script/testnet/TestnetFixtureTokens.sol";
import {BasketFactory, ICanonicalAssetRegistry, ICreatorLicense} from "../src/BasketFactory.sol";
import {BasketToken} from "../src/BasketToken.sol";
import {CanonicalAssetRegistry} from "../src/CanonicalAssetRegistry.sol";
import {CreatorLicense} from "../src/CreatorLicense.sol";
import {CuratorGuardian} from "../src/CuratorGuardian.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";

contract DeployTestnetFixturesHarness is DeployTestnetFixtures {
    function deploy(address recipient)
        external
        returns (
            WovenTestnetFixture woven,
            BStockTestnetFixture nvdab,
            BStockTestnetFixture msftb,
            BStockTestnetFixture tslab,
            BStockTestnetFixture qqqb
        )
    {
        return _deploy(recipient);
    }

    function validateChain(uint256 expectedChainId) external view {
        _validateChain(expectedChainId);
    }
}

contract TestnetFixtureWovenValidationHarness is DeployCore {
    function validateWoven(address woven) external view {
        _validateWoven(woven);
    }
}

contract TestnetFixtureDeploymentTest is Test {
    address internal creator = makeAddr("fixtureCreator");
    address internal protocolAdmin = makeAddr("fixtureProtocolAdmin");
    address internal treasury = makeAddr("fixtureTreasury");

    DeployTestnetFixturesHarness internal deployer;

    function setUp() public {
        deployer = new DeployTestnetFixturesHarness();
    }

    function test_localFixtureWovenPassesCoreGateAndAssetsExposeScaledUI() public {
        (
            WovenTestnetFixture woven,
            BStockTestnetFixture nvdab,
            BStockTestnetFixture msftb,
            BStockTestnetFixture tslab,
            BStockTestnetFixture qqqb
        ) = deployer.deploy(creator);

        new TestnetFixtureWovenValidationHarness().validateWoven(address(woven));
        assertTrue(woven.isTestnetFixture());
        assertEq(woven.balanceOf(creator), 1_000_000_000e18);
        assertEq(woven._mode(), 0);
        assertEq(woven.owner(), address(0));

        BStockTestnetFixture[4] memory assets = [nvdab, msftb, tslab, qqqb];
        string[4] memory symbols = [string("NVDAB"), "MSFTB", "TSLAB", "QQQB"];
        assertEq(type(IScaledUIAmountFixture).interfaceId, bytes4(0xa60bf13d));
        assertEq(type(IScaledUIAmountConversionFixture).interfaceId, bytes4(0x57854fc3));
        assertEq(type(IScaledUIAmountPendingFixture).interfaceId, bytes4(0x4bd27648));
        for (uint256 i = 0; i < assets.length; ++i) {
            assertTrue(assets[i].isTestnetFixture());
            assertEq(assets[i].symbol(), symbols[i]);
            assertEq(assets[i].balanceOf(creator), 1_000_000e18);
            assertEq(assets[i].uiMultiplier(), 1e18);
            assertEq(assets[i].newUIMultiplier(), 1e18);
            assertEq(assets[i].effectiveAt(), 0);
            assertEq(assets[i].toUIAmount(12_345e18), 12_345e18);
            assertEq(assets[i].fromUIAmount(12_345e18), 12_345e18);
            assertTrue(assets[i].supportsInterface(type(IScaledUIAmountFixture).interfaceId));
            assertTrue(assets[i].supportsInterface(type(IScaledUIAmountConversionFixture).interfaceId));
            assertTrue(assets[i].supportsInterface(type(IScaledUIAmountPendingFixture).interfaceId));
        }
    }

    function test_deploymentScriptDeploysCompleteLocalSetWithExplicitInputs() public {
        vm.setEnv("CONFIRM_TESTNET_FIXTURE_DEPLOY", "true");
        vm.setEnv("FIXTURE_EXPECTED_CHAIN_ID", "31337");
        vm.setEnv("TESTNET_FIXTURE_RECIPIENT", vm.toString(creator));

        (
            WovenTestnetFixture woven,
            BStockTestnetFixture nvdab,
            BStockTestnetFixture msftb,
            BStockTestnetFixture tslab,
            BStockTestnetFixture qqqb
        ) = deployer.run();

        assertEq(woven.balanceOf(creator), woven.FIXTURE_SUPPLY());
        assertEq(nvdab.balanceOf(creator), nvdab.FIXTURE_SUPPLY());
        assertEq(msftb.balanceOf(creator), msftb.FIXTURE_SUPPLY());
        assertEq(tslab.balanceOf(creator), tslab.FIXTURE_SUPPLY());
        assertEq(qqqb.balanceOf(creator), qqqb.FIXTURE_SUPPLY());
    }

    function test_fixtureSetExercisesLicenseCreateMintAndRedeem() public {
        (
            WovenTestnetFixture woven,
            BStockTestnetFixture nvdab,
            BStockTestnetFixture msftb,
            BStockTestnetFixture tslab,
            BStockTestnetFixture qqqb
        ) = deployer.deploy(creator);

        CreatorLicense creatorLicense = new CreatorLicense(IERC20(address(woven)));
        CanonicalAssetRegistry registry = new CanonicalAssetRegistry(protocolAdmin);
        FeeSplitter splitter = new FeeSplitter(treasury);
        CuratorGuardian guardian = new CuratorGuardian(protocolAdmin);
        BasketFactory factory = new BasketFactory(
            ICreatorLicense(address(creatorLicense)),
            ICanonicalAssetRegistry(address(registry)),
            splitter,
            address(guardian)
        );
        splitter.initFactory(address(factory));

        address[] memory assets = new address[](4);
        assets[0] = address(nvdab);
        assets[1] = address(msftb);
        assets[2] = address(tslab);
        assets[3] = address(qqqb);
        vm.prank(protocolAdmin);
        registry.setAssets(assets, true);

        vm.startPrank(creator);
        woven.approve(address(creatorLicense), creatorLicense.LICENSE_BURN_AMOUNT());
        creatorLicense.burnForLicense();

        uint256[] memory units = new uint256[](4);
        for (uint256 i = 0; i < units.length; ++i) {
            units[i] = 1e16;
        }
        BasketToken basket =
            BasketToken(factory.createBasket("Fixture Core Four", "tCORE4", assets, units, 30, 1_000e18));

        uint256 grossBasketAmount = 10e18;
        (, uint256[] memory required) = basket.getRequiredUnits(grossBasketAmount);
        for (uint256 i = 0; i < assets.length; ++i) {
            IERC20(assets[i]).approve(address(basket), required[i]);
        }
        basket.mint(grossBasketAmount, creator);

        uint256 mintFee = (grossBasketAmount * 30) / 10_000;
        splitter.distribute(address(basket));
        uint256 creatorFeeShare = (mintFee * splitter.CREATOR_SHARE_BPS()) / 10_000;
        uint256 treasuryFeeShare = mintFee - creatorFeeShare;
        assertEq(basket.balanceOf(treasury), treasuryFeeShare);

        uint256 redeemable = basket.balanceOf(creator);
        basket.redeem(redeemable, creator);
        vm.stopPrank();

        assertTrue(creatorLicense.isLicensed(creator));
        assertEq(factory.basketCount(), 1);
        assertEq(basket.totalSupply(), treasuryFeeShare);
        assertTrue(basket.isFullyBacked());
    }

    function test_fixtureContractsRejectBnbMainnetEvenWithoutTheScript() public {
        vm.chainId(56);
        vm.expectRevert(
            abi.encodeWithSelector(TestnetFixtureChainGuard.TestnetFixtureUnsupportedChain.selector, uint256(56))
        );
        new WovenTestnetFixture(creator);
    }

    function test_deploymentGuardAllowsOnlyTheExactLocalOrTestnetChain() public {
        deployer.validateChain(31_337);

        vm.expectRevert(abi.encodeWithSelector(DeployTestnetFixtures.FixtureChainNotAllowed.selector, uint256(56)));
        deployer.validateChain(56);

        vm.chainId(97);
        deployer.validateChain(97);
        vm.expectRevert(
            abi.encodeWithSelector(DeployTestnetFixtures.FixtureChainMismatch.selector, uint256(31_337), uint256(97))
        );
        deployer.validateChain(31_337);
    }
}
