// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {BasketToken} from "../src/BasketToken.sol";
import {BasketFactory, ICreatorLicense, ICanonicalAssetRegistry} from "../src/BasketFactory.sol";
import {CanonicalAssetRegistry} from "../src/CanonicalAssetRegistry.sol";
import {CreatorLicense} from "../src/CreatorLicense.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";
import {OneClickBasketRouter} from "../src/OneClickBasketRouter.sol";
import {MockERC20, FeeOnTransferToken} from "./mocks/MockERC20.sol";
import {MockExactOutputAdapter, FakeBasket} from "./mocks/MockExactOutputAdapter.sol";
import {DirectionalRefundFeeToken, SenderSurchargeToken} from "./mocks/DirectionalFeeTokens.sol";

/// @notice Unit and adversarial integration coverage for the atomic USDC basket route.
contract OneClickBasketRouterTest is Test {
    uint256 internal constant LICENSE_AMOUNT = 10_000e18;
    uint256 internal constant GROSS_BASKET_AMOUNT = 10e18;
    uint256 internal constant REQUIRED_STOCK_A = 20e18;
    uint256 internal constant REQUIRED_STOCK_B = 5e18;
    uint256 internal constant SPEND_A = 27e6;
    uint256 internal constant SPEND_B = 19e6;
    uint256 internal constant MAX_A = 40e6;
    uint256 internal constant MAX_B = 30e6;
    uint256 internal constant MAX_TOTAL = MAX_A + MAX_B;
    uint256 internal constant USER_USDC = 1_000e6;

    bytes32 internal constant ROUTE_A = keccak256("USDC-STOCK-A");
    bytes32 internal constant ROUTE_B = keccak256("USDC-STOCK-B");
    bytes32 internal constant ROUTE_FEE = keccak256("USDC-FEE-STOCK");

    address internal creator = makeAddr("creator");
    address internal payer = makeAddr("payer");
    address internal recipient = makeAddr("recipient");
    address internal protocolSafe = makeAddr("protocolSafe");
    address internal treasury = makeAddr("treasury");

    MockERC20 internal usdc;
    MockERC20 internal woven;
    MockERC20 internal stockA;
    MockERC20 internal stockB;
    CreatorLicense internal creatorLicense;
    CanonicalAssetRegistry internal assetRegistry;
    FeeSplitter internal splitter;
    BasketFactory internal factory;
    BasketToken internal basket;
    MockExactOutputAdapter internal adapter;
    OneClickBasketRouter internal router;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC");
        woven = new MockERC20("Woven", "WOVEN");
        stockA = new MockERC20("Stock A", "STKA");
        stockB = new MockERC20("Stock B", "STKB");

        creatorLicense = new CreatorLicense(IERC20(address(woven)));
        assetRegistry = new CanonicalAssetRegistry(protocolSafe);
        splitter = new FeeSplitter(treasury);
        factory = new BasketFactory(
            ICreatorLicense(address(creatorLicense)),
            ICanonicalAssetRegistry(address(assetRegistry)),
            splitter,
            protocolSafe
        );
        splitter.initFactory(address(factory));

        address[] memory assets = new address[](2);
        assets[0] = address(stockA);
        assets[1] = address(stockB);
        vm.prank(protocolSafe);
        assetRegistry.setAssets(assets, true);

        woven.mint(creator, LICENSE_AMOUNT);
        vm.startPrank(creator);
        woven.approve(address(creatorLicense), LICENSE_AMOUNT);
        creatorLicense.burnForLicense();
        vm.stopPrank();

        address[] memory tokens = new address[](2);
        tokens[0] = address(stockA);
        tokens[1] = address(stockB);
        uint256[] memory units = new uint256[](2);
        units[0] = 2e18;
        units[1] = 5e17;
        basket = _createBasket(tokens, units, 30);

        adapter = new MockExactOutputAdapter(address(usdc));
        adapter.configureRoute(ROUTE_A, address(stockA), SPEND_A);
        adapter.configureRoute(ROUTE_B, address(stockB), SPEND_B);
        stockA.mint(address(adapter), 1_000_000e18);
        stockB.mint(address(adapter), 1_000_000e18);

        address[] memory adapters_ = new address[](1);
        adapters_[0] = address(adapter);
        router = new OneClickBasketRouter(address(usdc), address(factory), adapters_);

        usdc.mint(payer, USER_USDC);
        vm.prank(payer);
        usdc.approve(address(router), type(uint256).max);
    }

    function test_mintsExactBasketAtomicallyAndRefundsUnusedUsdc() public {
        uint256 deadline = block.timestamp + 5 minutes;
        uint256 expectedNet = _expectedNet(GROSS_BASKET_AMOUNT, 30);
        OneClickBasketRouter.SwapLeg[] memory legs = _defaultLegs();

        vm.prank(payer);
        (uint256 netBasketOut, uint256 usdcSpent) =
            router.mintWithUsdc(address(basket), GROSS_BASKET_AMOUNT, expectedNet, recipient, MAX_TOTAL, deadline, legs);

        assertEq(netBasketOut, expectedNet);
        assertEq(usdcSpent, SPEND_A + SPEND_B);
        assertEq(basket.balanceOf(recipient), expectedNet);
        assertEq(basket.balanceOf(address(splitter)), GROSS_BASKET_AMOUNT - expectedNet);
        assertEq(usdc.balanceOf(payer), USER_USDC - SPEND_A - SPEND_B);
        assertEq(usdc.balanceOf(address(adapter)), SPEND_A + SPEND_B);
        assertEq(stockA.balanceOf(address(basket)), REQUIRED_STOCK_A);
        assertEq(stockB.balanceOf(address(basket)), REQUIRED_STOCK_B);
        assertEq(basket.totalSupply(), GROSS_BASKET_AMOUNT);
        assertTrue(basket.isFullyBacked());
    }

    function test_restoresDonatedBaselinesAndClearsEveryTemporaryApproval() public {
        uint256 donatedUsdc = 7e6;
        uint256 donatedStockA = 3e18;
        uint256 donatedStockB = 4e18;
        usdc.mint(address(router), donatedUsdc);
        stockA.mint(address(router), donatedStockA);
        stockB.mint(address(router), donatedStockB);

        _mintDefault(_expectedNet(GROSS_BASKET_AMOUNT, 30));

        assertEq(usdc.balanceOf(address(router)), donatedUsdc);
        assertEq(stockA.balanceOf(address(router)), donatedStockA);
        assertEq(stockB.balanceOf(address(router)), donatedStockB);
        assertEq(usdc.allowance(address(router), address(adapter)), 0);
        assertEq(stockA.allowance(address(router), address(basket)), 0);
        assertEq(stockB.allowance(address(router), address(basket)), 0);
        assertEq(usdc.balanceOf(payer), USER_USDC - SPEND_A - SPEND_B);
    }

    function test_secondLegFailureRollsBackFirstSwapAndPayerTransfer() public {
        adapter.setFailure(ROUTE_B, true);

        uint256 adapterStockABefore = stockA.balanceOf(address(adapter));
        uint256 adapterStockBBefore = stockB.balanceOf(address(adapter));
        OneClickBasketRouter.SwapLeg[] memory legs = _defaultLegs();

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(MockExactOutputAdapter.ForcedFailure.selector, ROUTE_B));
        router.mintWithUsdc(
            address(basket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, block.timestamp + 5 minutes, legs
        );

        assertEq(usdc.balanceOf(payer), USER_USDC);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(stockA.balanceOf(address(adapter)), adapterStockABefore);
        assertEq(stockB.balanceOf(address(adapter)), adapterStockBBefore);
        assertEq(basket.totalSupply(), 0);
        assertEq(basket.balanceOf(recipient), 0);
        assertEq(usdc.allowance(address(router), address(adapter)), 0);
    }

    function test_minimumBasketOutputFailureRollsBackSwapsAndMint() public {
        uint256 minimum = _expectedNet(GROSS_BASKET_AMOUNT, 30) + 1;
        OneClickBasketRouter.SwapLeg[] memory legs = _defaultLegs();

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(OneClickBasketRouter.BasketOutputBelowMinimum.selector, minimum, minimum - 1)
        );
        router.mintWithUsdc(
            address(basket), GROSS_BASKET_AMOUNT, minimum, recipient, MAX_TOTAL, block.timestamp + 5 minutes, legs
        );

        assertEq(usdc.balanceOf(payer), USER_USDC);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(stockA.balanceOf(address(basket)), 0);
        assertEq(stockB.balanceOf(address(basket)), 0);
        assertEq(basket.totalSupply(), 0);
    }

    function test_rejectsTotalMaximumThatDoesNotEqualLegSum() public {
        OneClickBasketRouter.SwapLeg[] memory legs = _defaultLegs();
        uint256 declaredMaximum = MAX_TOTAL - 1;

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(OneClickBasketRouter.TotalMaximumMismatch.selector, declaredMaximum, MAX_TOTAL)
        );
        router.mintWithUsdc(
            address(basket), GROSS_BASKET_AMOUNT, 0, recipient, declaredMaximum, block.timestamp + 5 minutes, legs
        );
    }

    function test_rejectsZeroLegMaximum() public {
        OneClickBasketRouter.SwapLeg[] memory legs = _defaultLegs();
        legs[1].maxUsdcIn = 0;

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(OneClickBasketRouter.ZeroLegMaximum.selector, 1));
        router.mintWithUsdc(
            address(basket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_A, block.timestamp + 5 minutes, legs
        );
    }

    function test_legCannotSpendMoreThanItsApprovedMaximum() public {
        adapter.setSpend(ROUTE_A, MAX_A + 1);
        OneClickBasketRouter.SwapLeg[] memory legs = _defaultLegs();

        vm.prank(payer);
        vm.expectRevert();
        router.mintWithUsdc(
            address(basket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, block.timestamp + 5 minutes, legs
        );

        assertEq(usdc.balanceOf(payer), USER_USDC);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(basket.totalSupply(), 0);
    }

    function test_rejectsExpiredAndOverlongDeadlines() public {
        vm.warp(1_000_000);
        OneClickBasketRouter.SwapLeg[] memory legs = _defaultLegs();

        vm.prank(payer);
        vm.expectRevert(OneClickBasketRouter.Expired.selector);
        router.mintWithUsdc(address(basket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, block.timestamp - 1, legs);

        uint256 overlong = block.timestamp + router.MAX_DEADLINE_WINDOW() + 1;
        uint256 maximum = block.timestamp + router.MAX_DEADLINE_WINDOW();
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(OneClickBasketRouter.DeadlineTooFar.selector, overlong, maximum));
        router.mintWithUsdc(address(basket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, overlong, legs);
    }

    function test_rejectsBasketNotCreatedByCanonicalFactory() public {
        FakeBasket fakeBasket = new FakeBasket();
        OneClickBasketRouter.SwapLeg[] memory legs = _defaultLegs();

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(OneClickBasketRouter.UnknownBasket.selector, address(fakeBasket)));
        router.mintWithUsdc(
            address(fakeBasket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, block.timestamp + 5 minutes, legs
        );
    }

    function test_rejectsConstituentDelistedAfterBasketCreation() public {
        vm.prank(protocolSafe);
        assetRegistry.setAsset(address(stockA), false);
        OneClickBasketRouter.SwapLeg[] memory legs = _defaultLegs();

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(OneClickBasketRouter.UnsupportedAsset.selector, address(stockA)));
        router.mintWithUsdc(
            address(basket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, block.timestamp + 5 minutes, legs
        );
    }

    function test_rejectsWrongLegTokenAmountAndRoute() public {
        OneClickBasketRouter.SwapLeg[] memory legs = _defaultLegs();
        legs[0].expectedToken = address(stockB);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(OneClickBasketRouter.LegTokenMismatch.selector, 0, address(stockA), address(stockB))
        );
        router.mintWithUsdc(
            address(basket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, block.timestamp + 5 minutes, legs
        );

        legs = _defaultLegs();
        legs[0].expectedAmountOut = REQUIRED_STOCK_A - 1;
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                OneClickBasketRouter.LegAmountMismatch.selector, 0, REQUIRED_STOCK_A, REQUIRED_STOCK_A - 1
            )
        );
        router.mintWithUsdc(
            address(basket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, block.timestamp + 5 minutes, legs
        );

        legs = _defaultLegs();
        legs[0].routeId = ROUTE_B;
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                OneClickBasketRouter.AdapterRouteMismatch.selector,
                address(adapter),
                ROUTE_B,
                address(stockA),
                address(stockB)
            )
        );
        router.mintWithUsdc(
            address(basket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, block.timestamp + 5 minutes, legs
        );
    }

    function test_rejectsMissingAndExtraLegs() public {
        OneClickBasketRouter.SwapLeg[] memory missing = new OneClickBasketRouter.SwapLeg[](1);
        missing[0] = _defaultLegs()[0];
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(OneClickBasketRouter.LegCountMismatch.selector, 2, 1));
        router.mintWithUsdc(
            address(basket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, block.timestamp + 5 minutes, missing
        );

        OneClickBasketRouter.SwapLeg[] memory extra = new OneClickBasketRouter.SwapLeg[](3);
        OneClickBasketRouter.SwapLeg[] memory defaults = _defaultLegs();
        extra[0] = defaults[0];
        extra[1] = defaults[1];
        extra[2] = defaults[1];
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(OneClickBasketRouter.LegCountMismatch.selector, 2, 3));
        router.mintWithUsdc(
            address(basket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, block.timestamp + 5 minutes, extra
        );
    }

    function test_rejectsAdapterThatWasNotPinnedAtDeployment() public {
        MockExactOutputAdapter rogue = new MockExactOutputAdapter(address(usdc));
        rogue.configureRoute(ROUTE_A, address(stockA), SPEND_A);
        OneClickBasketRouter.SwapLeg[] memory legs = _defaultLegs();
        legs[0].adapter = address(rogue);

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(OneClickBasketRouter.UnapprovedAdapter.selector, address(rogue)));
        router.mintWithUsdc(
            address(basket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, block.timestamp + 5 minutes, legs
        );
    }

    function test_rejectsPinnedAdapterWhoseRuntimeCodeChanges() public {
        bytes32 pinnedCodehash = router.adapterCodehash(address(adapter));
        vm.etch(address(adapter), hex"60006000fd");
        bytes32 changedCodehash = address(adapter).codehash;
        OneClickBasketRouter.SwapLeg[] memory legs = _defaultLegs();

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                OneClickBasketRouter.AdapterCodeChanged.selector, address(adapter), pinnedCodehash, changedCodehash
            )
        );
        router.mintWithUsdc(
            address(basket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, block.timestamp + 5 minutes, legs
        );
    }

    function test_rejectsMaliciousAdapterSpendReport() public {
        adapter.setReportDelta(ROUTE_A, 1);
        OneClickBasketRouter.SwapLeg[] memory legs = _defaultLegs();

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(OneClickBasketRouter.AdapterSpendMismatch.selector, 0, SPEND_A + 1, SPEND_A)
        );
        router.mintWithUsdc(
            address(basket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, block.timestamp + 5 minutes, legs
        );

        assertEq(usdc.balanceOf(payer), USER_USDC);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(basket.totalSupply(), 0);
    }

    function test_rejectsMaliciousAdapterUnderDelivery() public {
        adapter.setOutputDelta(ROUTE_A, -1);
        OneClickBasketRouter.SwapLeg[] memory legs = _defaultLegs();

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                OneClickBasketRouter.ConstituentOutputMismatch.selector, 0, REQUIRED_STOCK_A, REQUIRED_STOCK_A - 1
            )
        );
        router.mintWithUsdc(
            address(basket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, block.timestamp + 5 minutes, legs
        );

        assertEq(usdc.balanceOf(payer), USER_USDC);
        assertEq(stockA.balanceOf(address(router)), 0);
        assertEq(basket.totalSupply(), 0);
    }

    function test_rejectsFeeOnTransferInputToken() public {
        FeeOnTransferToken taxedUsdc = new FeeOnTransferToken();
        MockExactOutputAdapter taxedAdapter = new MockExactOutputAdapter(address(taxedUsdc));
        taxedAdapter.configureRoute(ROUTE_A, address(stockA), SPEND_A);
        taxedAdapter.configureRoute(ROUTE_B, address(stockB), SPEND_B);
        stockA.mint(address(taxedAdapter), REQUIRED_STOCK_A);
        stockB.mint(address(taxedAdapter), REQUIRED_STOCK_B);

        address[] memory adapters_ = new address[](1);
        adapters_[0] = address(taxedAdapter);
        OneClickBasketRouter taxedRouter = new OneClickBasketRouter(address(taxedUsdc), address(factory), adapters_);
        taxedUsdc.mint(payer, USER_USDC);
        vm.prank(payer);
        taxedUsdc.approve(address(taxedRouter), MAX_TOTAL);

        OneClickBasketRouter.SwapLeg[] memory legs = _legsFor(address(taxedAdapter));
        uint256 received = MAX_TOTAL - (MAX_TOTAL / 100);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(OneClickBasketRouter.InexactUsdcTransfer.selector, MAX_TOTAL, received));
        taxedRouter.mintWithUsdc(
            address(basket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, block.timestamp + 5 minutes, legs
        );

        assertEq(taxedUsdc.balanceOf(payer), USER_USDC);
        assertEq(taxedUsdc.balanceOf(address(taxedRouter)), 0);
        assertEq(basket.totalSupply(), 0);
    }

    function test_rejectsSenderSurchargeEvenWhenRouterReceivesExactMaximum() public {
        SenderSurchargeToken surchargeUsdc = new SenderSurchargeToken();
        MockExactOutputAdapter surchargeAdapter = new MockExactOutputAdapter(address(surchargeUsdc));
        surchargeAdapter.configureRoute(ROUTE_A, address(stockA), SPEND_A);
        surchargeAdapter.configureRoute(ROUTE_B, address(stockB), SPEND_B);
        stockA.mint(address(surchargeAdapter), REQUIRED_STOCK_A);
        stockB.mint(address(surchargeAdapter), REQUIRED_STOCK_B);

        address[] memory adapters_ = new address[](1);
        adapters_[0] = address(surchargeAdapter);
        OneClickBasketRouter surchargeRouter =
            new OneClickBasketRouter(address(surchargeUsdc), address(factory), adapters_);
        surchargeUsdc.mint(payer, USER_USDC);
        vm.prank(payer);
        surchargeUsdc.approve(address(surchargeRouter), MAX_TOTAL);

        uint256 payerDebit = MAX_TOTAL + (MAX_TOTAL / 100);
        OneClickBasketRouter.SwapLeg[] memory legs = _legsFor(address(surchargeAdapter));
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(OneClickBasketRouter.InexactUsdcDebit.selector, MAX_TOTAL, payerDebit));
        surchargeRouter.mintWithUsdc(
            address(basket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, block.timestamp + 5 minutes, legs
        );

        assertEq(surchargeUsdc.balanceOf(payer), USER_USDC);
        assertEq(surchargeUsdc.balanceOf(address(surchargeRouter)), 0);
        assertEq(basket.totalSupply(), 0);
    }

    function test_rejectsTaxedOutboundRefundWhenPayerReceivesLess() public {
        DirectionalRefundFeeToken refundFeeUsdc = new DirectionalRefundFeeToken();
        MockExactOutputAdapter refundAdapter = new MockExactOutputAdapter(address(refundFeeUsdc));
        refundAdapter.configureRoute(ROUTE_A, address(stockA), SPEND_A);
        refundAdapter.configureRoute(ROUTE_B, address(stockB), SPEND_B);
        stockA.mint(address(refundAdapter), REQUIRED_STOCK_A);
        stockB.mint(address(refundAdapter), REQUIRED_STOCK_B);

        address[] memory adapters_ = new address[](1);
        adapters_[0] = address(refundAdapter);
        OneClickBasketRouter refundRouter =
            new OneClickBasketRouter(address(refundFeeUsdc), address(factory), adapters_);
        refundFeeUsdc.setTaxedSender(address(refundRouter));
        refundFeeUsdc.mint(payer, USER_USDC);
        vm.prank(payer);
        refundFeeUsdc.approve(address(refundRouter), MAX_TOTAL);

        uint256 refund = MAX_TOTAL - SPEND_A - SPEND_B;
        uint256 receivedRefund = refund - (refund / 100);
        OneClickBasketRouter.SwapLeg[] memory legs = _legsFor(address(refundAdapter));
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(OneClickBasketRouter.InexactUsdcRefund.selector, refund, receivedRefund));
        refundRouter.mintWithUsdc(
            address(basket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, block.timestamp + 5 minutes, legs
        );

        assertEq(refundFeeUsdc.balanceOf(payer), USER_USDC);
        assertEq(refundFeeUsdc.balanceOf(address(refundRouter)), 0);
        assertEq(basket.totalSupply(), 0);
    }

    function test_rejectsFeeOnTransferConstituent() public {
        FeeOnTransferToken taxedStock = new FeeOnTransferToken();
        vm.prank(protocolSafe);
        assetRegistry.setAsset(address(taxedStock), true);

        address[] memory tokens = new address[](2);
        tokens[0] = address(taxedStock);
        tokens[1] = address(stockB);
        uint256[] memory units = new uint256[](2);
        units[0] = 1e18;
        units[1] = 5e17;
        BasketToken taxedBasket = _createBasket(tokens, units, 30);

        adapter.configureRoute(ROUTE_FEE, address(taxedStock), SPEND_A);
        taxedStock.mint(address(adapter), GROSS_BASKET_AMOUNT);

        OneClickBasketRouter.SwapLeg[] memory legs = new OneClickBasketRouter.SwapLeg[](2);
        legs[0] = OneClickBasketRouter.SwapLeg({
            expectedToken: address(taxedStock),
            adapter: address(adapter),
            routeId: ROUTE_FEE,
            expectedAmountOut: GROSS_BASKET_AMOUNT,
            maxUsdcIn: MAX_A
        });
        legs[1] = OneClickBasketRouter.SwapLeg({
            expectedToken: address(stockB),
            adapter: address(adapter),
            routeId: ROUTE_B,
            expectedAmountOut: REQUIRED_STOCK_B,
            maxUsdcIn: MAX_B
        });

        uint256 received = GROSS_BASKET_AMOUNT - (GROSS_BASKET_AMOUNT / 100);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                OneClickBasketRouter.ConstituentOutputMismatch.selector, 0, GROSS_BASKET_AMOUNT, received
            )
        );
        router.mintWithUsdc(
            address(taxedBasket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, block.timestamp + 5 minutes, legs
        );

        assertEq(usdc.balanceOf(payer), USER_USDC);
        assertEq(taxedBasket.totalSupply(), 0);
    }

    function test_blocksAdapterReentrancyWithoutBreakingOuterMint() public {
        OneClickBasketRouter.SwapLeg[] memory legs = _defaultLegs();
        bytes memory reentryCall = abi.encodeCall(
            OneClickBasketRouter.mintWithUsdc,
            (address(basket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, block.timestamp + 5 minutes, legs)
        );
        adapter.setReentry(address(router), reentryCall, ROUTE_A);

        _mintDefault(_expectedNet(GROSS_BASKET_AMOUNT, 30));

        assertTrue(adapter.reentryAttempted());
        assertFalse(adapter.reentrySucceeded());
        assertEq(
            adapter.reentryReturnData(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
        );
        assertEq(basket.balanceOf(recipient), _expectedNet(GROSS_BASKET_AMOUNT, 30));
        assertEq(basket.totalSupply(), GROSS_BASKET_AMOUNT);
    }

    function test_rejectsUsdcAsBasketConstituent() public {
        vm.prank(protocolSafe);
        assetRegistry.setAsset(address(usdc), true);

        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc);
        tokens[1] = address(stockA);
        uint256[] memory units = new uint256[](2);
        units[0] = 1e6;
        units[1] = 1e18;
        BasketToken usdcBasket = _createBasket(tokens, units, 30);

        OneClickBasketRouter.SwapLeg[] memory legs = _defaultLegs();
        vm.prank(payer);
        vm.expectRevert(OneClickBasketRouter.UsdcConstituentUnsupported.selector);
        router.mintWithUsdc(
            address(usdcBasket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, block.timestamp + 5 minutes, legs
        );
    }

    function test_rejectsBasketAboveRoutedConstituentLimit() public {
        uint256 count = router.MAX_ROUTED_CONSTITUENTS() + 1;
        address[] memory tokens = new address[](count);
        uint256[] memory units = new uint256[](count);
        for (uint256 i = 0; i < count; ++i) {
            MockERC20 token = new MockERC20("Extra Stock", "EXT");
            tokens[i] = address(token);
            units[i] = 1e18;
        }
        vm.prank(protocolSafe);
        assetRegistry.setAssets(tokens, true);
        BasketToken oversizedBasket = _createBasket(tokens, units, 30);
        OneClickBasketRouter.SwapLeg[] memory noLegs = new OneClickBasketRouter.SwapLeg[](0);

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(OneClickBasketRouter.InvalidConstituentCount.selector, count));
        router.mintWithUsdc(
            address(oversizedBasket), GROSS_BASKET_AMOUNT, 0, recipient, MAX_TOTAL, block.timestamp + 5 minutes, noLegs
        );
    }

    function _createBasket(address[] memory tokens, uint256[] memory units, uint16 feeBps)
        internal
        returns (BasketToken created)
    {
        vm.prank(creator);
        created = BasketToken(factory.createBasket("Test Basket", "TEST", tokens, units, feeBps, 1_000e18));
    }

    function _defaultLegs() internal view returns (OneClickBasketRouter.SwapLeg[] memory legs) {
        return _legsFor(address(adapter));
    }

    function _legsFor(address adapterAddress) internal view returns (OneClickBasketRouter.SwapLeg[] memory legs) {
        legs = new OneClickBasketRouter.SwapLeg[](2);
        legs[0] = OneClickBasketRouter.SwapLeg({
            expectedToken: address(stockA),
            adapter: adapterAddress,
            routeId: ROUTE_A,
            expectedAmountOut: REQUIRED_STOCK_A,
            maxUsdcIn: MAX_A
        });
        legs[1] = OneClickBasketRouter.SwapLeg({
            expectedToken: address(stockB),
            adapter: adapterAddress,
            routeId: ROUTE_B,
            expectedAmountOut: REQUIRED_STOCK_B,
            maxUsdcIn: MAX_B
        });
    }

    function _mintDefault(uint256 minimumOut) internal returns (uint256 netBasketOut, uint256 usdcSpent) {
        OneClickBasketRouter.SwapLeg[] memory legs = _defaultLegs();
        vm.prank(payer);
        return router.mintWithUsdc(
            address(basket), GROSS_BASKET_AMOUNT, minimumOut, recipient, MAX_TOTAL, block.timestamp + 5 minutes, legs
        );
    }

    function _expectedNet(uint256 gross, uint16 feeBps) internal pure returns (uint256) {
        return gross - ((gross * feeBps) / 10_000);
    }
}
