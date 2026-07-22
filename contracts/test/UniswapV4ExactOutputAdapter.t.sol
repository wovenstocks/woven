// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {UniswapV4ExactOutputAdapter} from "../src/adapters/UniswapV4ExactOutputAdapter.sol";
import {FeeOnTransferToken, MockERC20} from "./mocks/MockERC20.sol";
import {DirectionalRefundFeeToken, DirectionalSenderSurchargeToken} from "./mocks/DirectionalFeeTokens.sol";
import {MockPermit2, MockUniversalRouter, MockV4Quoter} from "./mocks/MockUniswapV4Dependencies.sol";

contract UniswapV4ExactOutputAdapterTest is Test {
    uint256 internal constant EXACT_OUTPUT = 2e18;
    uint256 internal constant MAX_INPUT = 100e6;
    uint256 internal constant ACTUAL_INPUT = 37e6;
    uint256 internal constant USER_INPUT = 500e6;
    uint256 internal constant QUOTE_GAS = 184_000;

    bytes32 internal constant ROUTE_ID = keccak256("WOVEN:UNISWAP_V4:USDC:STOCK:1");
    bytes32 internal constant UNKNOWN_ROUTE_ID = keccak256("UNKNOWN");

    address internal user = makeAddr("user");

    MockERC20 internal input;
    MockERC20 internal bridge;
    MockERC20 internal output;
    MockPermit2 internal permit2;
    MockV4Quoter internal quoter;
    MockUniversalRouter internal universalRouter;
    UniswapV4ExactOutputAdapter internal adapter;

    function setUp() public {
        input = new MockERC20("USD Coin", "USDC");
        bridge = new MockERC20("Tether USD", "USDT");
        output = new MockERC20("Stock", "STOCKB");
        permit2 = new MockPermit2();
        quoter = new MockV4Quoter();
        universalRouter = new MockUniversalRouter(permit2);

        universalRouter.configureSwap(ACTUAL_INPUT, 0);
        quoter.setQuote(ACTUAL_INPUT, QUOTE_GAS);
        output.mint(address(universalRouter), 1_000_000e18);

        adapter = _deployAdapter(address(input), address(output), ROUTE_ID);
        input.mint(user, USER_INPUT);
        vm.prank(user);
        input.approve(address(adapter), type(uint256).max);
    }

    function test_quoteUsesPinnedHookFreeForwardPath() public {
        (uint256 amountIn, uint256 gasEstimate) = adapter.quoteExactOutput(address(output), EXACT_OUTPUT, ROUTE_ID);

        assertEq(amountIn, ACTUAL_INPUT);
        assertEq(gasEstimate, QUOTE_GAS);
        assertEq(quoter.lastExactCurrency(), address(output));
        assertEq(quoter.lastExactAmount(), EXACT_OUTPUT);
        assertEq(quoter.lastPathLength(), 2);

        MockV4Quoter.StoredPathKey memory first = quoter.lastPath(0);
        assertEq(first.intermediateCurrency, address(input));
        assertEq(first.fee, 2);
        assertEq(first.tickSpacing, 1);
        assertEq(first.hooks, address(0));
        assertEq(first.hookDataLength, 0);
        assertEq(first.hookDataHash, keccak256(bytes("")));

        MockV4Quoter.StoredPathKey memory second = quoter.lastPath(1);
        assertEq(second.intermediateCurrency, address(bridge));
        assertEq(second.fee, 20_000);
        assertEq(second.tickSpacing, 400);
        assertEq(second.hooks, address(0));
        assertEq(second.hookDataLength, 0);
    }

    function test_routeGetterAndHashExposeTheImmutableRecipe() public view {
        (address configuredOutput, UniswapV4ExactOutputAdapter.HopConfig[] memory path) = adapter.route(ROUTE_ID);
        assertEq(configuredOutput, address(output));
        assertEq(path.length, 2);
        assertEq(path[0].intermediateCurrency, address(input));
        assertEq(path[0].fee, 2);
        assertEq(path[0].tickSpacing, 1);
        assertEq(path[1].intermediateCurrency, address(bridge));
        assertEq(path[1].fee, 20_000);
        assertEq(path[1].tickSpacing, 400);
        assertEq(adapter.routeHash(ROUTE_ID), keccak256(abi.encode(address(output), path)));
    }

    function test_swapEncodesUniversalRouterActionsRefundsAndClearsAllowances() public {
        uint256 inputBaseline = 7e6;
        uint256 outputBaseline = 3e18;
        input.mint(address(adapter), inputBaseline);
        output.mint(address(adapter), outputBaseline);
        uint256 deadline = block.timestamp + 5 minutes;

        vm.prank(user);
        uint256 amountIn = adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, deadline, ROUTE_ID);

        assertEq(amountIn, ACTUAL_INPUT);
        assertEq(input.balanceOf(user), USER_INPUT - ACTUAL_INPUT);
        assertEq(output.balanceOf(user), EXACT_OUTPUT);
        assertEq(input.balanceOf(address(adapter)), inputBaseline);
        assertEq(output.balanceOf(address(adapter)), outputBaseline);
        assertEq(input.balanceOf(address(universalRouter)), ACTUAL_INPUT);
        assertEq(input.allowance(address(adapter), address(permit2)), 0);
        (uint160 permitAmount, uint48 permitExpiration,) =
            permit2.allowance(address(adapter), address(input), address(universalRouter));
        assertEq(permitAmount, 0);
        assertEq(permitExpiration, 0);

        assertEq(universalRouter.lastCaller(), address(adapter));
        assertEq(universalRouter.lastCommands(), hex"10");
        assertEq(universalRouter.lastActions(), hex"090c0f");
        assertEq(universalRouter.lastDeadline(), deadline);
        assertEq(universalRouter.lastCurrencyOut(), address(output));
        assertEq(universalRouter.lastAmountOut(), EXACT_OUTPUT);
        assertEq(universalRouter.lastAmountInMaximum(), MAX_INPUT);
        assertEq(universalRouter.lastMinHopPriceLength(), 0);
        assertEq(universalRouter.lastSettleCurrency(), address(input));
        assertEq(universalRouter.lastSettleMaximum(), MAX_INPUT);
        assertEq(universalRouter.lastTakeCurrency(), address(output));
        assertEq(universalRouter.lastTakeMinimum(), EXACT_OUTPUT);
        assertEq(universalRouter.lastPathLength(), 2);

        MockUniversalRouter.StoredPathKey memory first = universalRouter.lastPath(0);
        assertEq(first.intermediateCurrency, address(input));
        assertEq(first.fee, 2);
        assertEq(first.tickSpacing, 1);
        assertEq(first.hooks, address(0));
        assertEq(first.hookDataLength, 0);

        MockUniversalRouter.StoredPathKey memory second = universalRouter.lastPath(1);
        assertEq(second.intermediateCurrency, address(bridge));
        assertEq(second.fee, 20_000);
        assertEq(second.tickSpacing, 400);
        assertEq(second.hooks, address(0));
        assertEq(second.hookDataLength, 0);
    }

    function test_routerFailureRollsBackInputAndAllApprovals() public {
        universalRouter.setFailure(true);

        vm.prank(user);
        vm.expectRevert(MockUniversalRouter.ForcedRouterFailure.selector);
        adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);

        assertEq(input.balanceOf(user), USER_INPUT);
        assertEq(output.balanceOf(user), 0);
        assertEq(input.balanceOf(address(adapter)), 0);
        assertEq(input.allowance(address(adapter), address(permit2)), 0);
        (uint160 permitAmount,,) = permit2.allowance(address(adapter), address(input), address(universalRouter));
        assertEq(permitAmount, 0);
    }

    function test_permit2EnforcesTheMaximumInputAtomically() public {
        universalRouter.configureSwap(MAX_INPUT + 1, 0);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                MockPermit2.InsufficientAllowance.selector, uint160(MAX_INPUT), uint160(MAX_INPUT + 1)
            )
        );
        adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);

        assertEq(input.balanceOf(user), USER_INPUT);
        assertEq(output.balanceOf(user), 0);
        assertEq(input.balanceOf(address(universalRouter)), 0);
    }

    function test_rejectsUnderAndOverDeliveryFromUniversalRouter() public {
        universalRouter.configureSwap(ACTUAL_INPUT, -1);
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV4ExactOutputAdapter.OutputAmountMismatch.selector, EXACT_OUTPUT, EXACT_OUTPUT - 1
            )
        );
        adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);

        universalRouter.configureSwap(ACTUAL_INPUT, 1);
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV4ExactOutputAdapter.OutputAmountMismatch.selector, EXACT_OUTPUT, EXACT_OUTPUT + 1
            )
        );
        adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);

        assertEq(input.balanceOf(user), USER_INPUT);
        assertEq(output.balanceOf(user), 0);
        assertEq(input.balanceOf(address(universalRouter)), 0);
    }

    function test_rejectsPermit2AllowanceThatCannotBeCleared() public {
        permit2.setIgnoreClear(true);
        uint256 remaining = MAX_INPUT - ACTUAL_INPUT;

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV4ExactOutputAdapter.AllowanceNotCleared.selector, address(universalRouter), remaining
            )
        );
        adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);

        assertEq(input.balanceOf(user), USER_INPUT);
        assertEq(output.balanceOf(user), 0);
    }

    function test_blocksUniversalRouterReentrancyWithoutBreakingOuterSwap() public {
        bytes memory reentryCall = abi.encodeCall(
            UniswapV4ExactOutputAdapter.swapExactOutput,
            (address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID)
        );
        universalRouter.setReentry(address(adapter), reentryCall);

        vm.prank(user);
        uint256 amountIn =
            adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);

        assertEq(amountIn, ACTUAL_INPUT);
        assertTrue(universalRouter.reentryAttempted());
        assertFalse(universalRouter.reentrySucceeded());
        assertEq(
            universalRouter.reentryReturnData(),
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
        );
        assertEq(output.balanceOf(user), EXACT_OUTPUT);
    }

    function test_rejectsFeeOnTransferInput() public {
        FeeOnTransferToken taxedInput = new FeeOnTransferToken();
        UniswapV4ExactOutputAdapter taxedAdapter = _deployAdapter(address(taxedInput), address(output), ROUTE_ID);
        taxedInput.mint(user, USER_INPUT);
        vm.prank(user);
        taxedInput.approve(address(taxedAdapter), MAX_INPUT);
        uint256 received = MAX_INPUT - (MAX_INPUT / 100);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV4ExactOutputAdapter.InexactInputTransfer.selector, MAX_INPUT, received)
        );
        taxedAdapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);

        assertEq(taxedInput.balanceOf(user), USER_INPUT);
        assertEq(taxedInput.balanceOf(address(taxedAdapter)), 0);
    }

    function test_rejectsFeeOnTransferOutput() public {
        FeeOnTransferToken taxedOutput = new FeeOnTransferToken();
        UniswapV4ExactOutputAdapter taxedAdapter = _deployAdapter(address(input), address(taxedOutput), ROUTE_ID);
        taxedOutput.mint(address(universalRouter), EXACT_OUTPUT);
        vm.prank(user);
        input.approve(address(taxedAdapter), MAX_INPUT);
        uint256 received = EXACT_OUTPUT - (EXACT_OUTPUT / 100);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV4ExactOutputAdapter.OutputAmountMismatch.selector, EXACT_OUTPUT, received)
        );
        taxedAdapter.swapExactOutput(
            address(taxedOutput), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID
        );

        assertEq(input.balanceOf(user), USER_INPUT);
        assertEq(taxedOutput.balanceOf(user), 0);
        assertEq(taxedOutput.balanceOf(address(taxedAdapter)), 0);
    }

    function test_rejectsCallerSurchargeEvenWhenAdapterReceivesExactMaximum() public {
        DirectionalSenderSurchargeToken surchargeInput = new DirectionalSenderSurchargeToken();
        surchargeInput.setSurchargedSender(user);
        UniswapV4ExactOutputAdapter surchargeAdapter =
            _deployAdapter(address(surchargeInput), address(output), ROUTE_ID);
        surchargeInput.mint(user, USER_INPUT);
        vm.prank(user);
        surchargeInput.approve(address(surchargeAdapter), MAX_INPUT);
        uint256 callerDebit = MAX_INPUT + (MAX_INPUT / 100);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV4ExactOutputAdapter.InexactCallerDebit.selector, MAX_INPUT, callerDebit)
        );
        surchargeAdapter.swapExactOutput(
            address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID
        );

        assertEq(surchargeInput.balanceOf(user), USER_INPUT);
        assertEq(surchargeInput.balanceOf(address(surchargeAdapter)), 0);
        assertEq(output.balanceOf(user), 0);
    }

    function test_rejectsTaxedOutboundRefundWhenCallerReceivesLess() public {
        DirectionalRefundFeeToken refundFeeInput = new DirectionalRefundFeeToken();
        UniswapV4ExactOutputAdapter refundAdapter = _deployAdapter(address(refundFeeInput), address(output), ROUTE_ID);
        refundFeeInput.setTaxedSender(address(refundAdapter));
        refundFeeInput.mint(user, USER_INPUT);
        vm.prank(user);
        refundFeeInput.approve(address(refundAdapter), MAX_INPUT);

        uint256 refund = MAX_INPUT - ACTUAL_INPUT;
        uint256 refundReceived = refund - (refund / 100);
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV4ExactOutputAdapter.InexactRefund.selector, refund, refundReceived)
        );
        refundAdapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);

        assertEq(refundFeeInput.balanceOf(user), USER_INPUT);
        assertEq(refundFeeInput.balanceOf(address(refundAdapter)), 0);
        assertEq(output.balanceOf(user), 0);
    }

    function test_quoteRejectsInvalidRequestAndChangedQuoterCode() public {
        vm.expectRevert(abi.encodeWithSelector(UniswapV4ExactOutputAdapter.RouteNotFound.selector, UNKNOWN_ROUTE_ID));
        adapter.quoteExactOutput(address(output), EXACT_OUTPUT, UNKNOWN_ROUTE_ID);

        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV4ExactOutputAdapter.RouteOutputMismatch.selector, address(output), address(input)
            )
        );
        adapter.quoteExactOutput(address(input), EXACT_OUTPUT, ROUTE_ID);

        vm.expectRevert(UniswapV4ExactOutputAdapter.ZeroAmount.selector);
        adapter.quoteExactOutput(address(output), 0, ROUTE_ID);

        vm.expectRevert(UniswapV4ExactOutputAdapter.AmountTooLarge.selector);
        adapter.quoteExactOutput(address(output), uint256(type(uint128).max) + 1, ROUTE_ID);

        quoter.setQuote(0, QUOTE_GAS);
        vm.expectRevert(UniswapV4ExactOutputAdapter.InvalidSwapResult.selector);
        adapter.quoteExactOutput(address(output), EXACT_OUTPUT, ROUTE_ID);

        bytes32 expected = adapter.quoterCodehash();
        vm.etch(address(quoter), hex"60006000fd");
        bytes32 actual = address(quoter).codehash;
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV4ExactOutputAdapter.DependencyCodeChanged.selector, address(quoter), expected, actual
            )
        );
        adapter.quoteExactOutput(address(output), EXACT_OUTPUT, ROUTE_ID);
    }

    function test_swapRejectsInvalidRouteAmountsAndDeadlines() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(UniswapV4ExactOutputAdapter.RouteNotFound.selector, UNKNOWN_ROUTE_ID));
        adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, UNKNOWN_ROUTE_ID);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV4ExactOutputAdapter.RouteOutputMismatch.selector, address(output), address(input)
            )
        );
        adapter.swapExactOutput(address(input), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);

        vm.prank(user);
        vm.expectRevert(UniswapV4ExactOutputAdapter.ZeroAmount.selector);
        adapter.swapExactOutput(address(output), 0, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);

        vm.prank(user);
        vm.expectRevert(UniswapV4ExactOutputAdapter.ZeroAmount.selector);
        adapter.swapExactOutput(address(output), EXACT_OUTPUT, 0, block.timestamp + 5 minutes, ROUTE_ID);

        vm.prank(user);
        vm.expectRevert(UniswapV4ExactOutputAdapter.AmountTooLarge.selector);
        adapter.swapExactOutput(
            address(output), uint256(type(uint128).max) + 1, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID
        );

        vm.warp(1_000_000);
        vm.prank(user);
        vm.expectRevert(UniswapV4ExactOutputAdapter.Expired.selector);
        adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp - 1, ROUTE_ID);

        vm.prank(user);
        vm.expectRevert(UniswapV4ExactOutputAdapter.DeadlineOverflow.selector);
        adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, uint256(type(uint48).max) + 1, ROUTE_ID);
    }

    function test_swapRejectsChangedUniversalRouterOrPermit2Code() public {
        bytes32 expectedRouterHash = adapter.universalRouterCodehash();
        vm.etch(address(universalRouter), hex"60006000fd");
        bytes32 actualRouterHash = address(universalRouter).codehash;
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV4ExactOutputAdapter.DependencyCodeChanged.selector,
                address(universalRouter),
                expectedRouterHash,
                actualRouterHash
            )
        );
        adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);

        setUp();
        bytes32 expectedPermitHash = adapter.permit2Codehash();
        vm.etch(address(permit2), hex"60006000fd");
        bytes32 actualPermitHash = address(permit2).codehash;
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV4ExactOutputAdapter.DependencyCodeChanged.selector,
                address(permit2),
                expectedPermitHash,
                actualPermitHash
            )
        );
        adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);
    }

    function test_constructorRejectsEmptyInvalidAndDuplicateRoutes() public {
        UniswapV4ExactOutputAdapter.RouteConfig[] memory noRoutes = new UniswapV4ExactOutputAdapter.RouteConfig[](0);
        vm.expectRevert(UniswapV4ExactOutputAdapter.NoRoutes.selector);
        new UniswapV4ExactOutputAdapter(
            address(input), address(universalRouter), address(permit2), address(quoter), noRoutes
        );

        UniswapV4ExactOutputAdapter.RouteConfig[] memory routes = _routes(address(input), address(output), bytes32(0));
        vm.expectRevert(UniswapV4ExactOutputAdapter.InvalidRouteId.selector);
        new UniswapV4ExactOutputAdapter(
            address(input), address(universalRouter), address(permit2), address(quoter), routes
        );

        routes = new UniswapV4ExactOutputAdapter.RouteConfig[](2);
        UniswapV4ExactOutputAdapter.RouteConfig[] memory one = _routes(address(input), address(output), ROUTE_ID);
        routes[0] = one[0];
        routes[1] = one[0];
        vm.expectRevert(abi.encodeWithSelector(UniswapV4ExactOutputAdapter.DuplicateRouteId.selector, ROUTE_ID));
        new UniswapV4ExactOutputAdapter(
            address(input), address(universalRouter), address(permit2), address(quoter), routes
        );
    }

    function test_constructorRejectsInvalidEndpointsFeesSpacingAndDuplicates() public {
        UniswapV4ExactOutputAdapter.RouteConfig[] memory routes = _routes(address(input), address(output), ROUTE_ID);
        routes[0].path[0].intermediateCurrency = address(bridge);
        vm.expectRevert(UniswapV4ExactOutputAdapter.InvalidPathEndpoint.selector);
        _newAdapter(address(input), routes);

        routes = _routes(address(input), address(output), ROUTE_ID);
        routes[0].path[1].fee = 0;
        vm.expectRevert(abi.encodeWithSelector(UniswapV4ExactOutputAdapter.InvalidPoolFee.selector, 1));
        _newAdapter(address(input), routes);

        routes = _routes(address(input), address(output), ROUTE_ID);
        routes[0].path[1].tickSpacing = 0;
        vm.expectRevert(abi.encodeWithSelector(UniswapV4ExactOutputAdapter.InvalidTickSpacing.selector, 1));
        _newAdapter(address(input), routes);

        routes = _routes(address(input), address(output), ROUTE_ID);
        routes[0].path[1].intermediateCurrency = address(input);
        vm.expectRevert(abi.encodeWithSelector(UniswapV4ExactOutputAdapter.DuplicatePathToken.selector, address(input)));
        _newAdapter(address(input), routes);

        routes = _routes(address(input), address(output), ROUTE_ID);
        routes[0].path[1].intermediateCurrency = address(output);
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV4ExactOutputAdapter.DuplicatePathToken.selector, address(output))
        );
        _newAdapter(address(input), routes);
    }

    function test_constructorRejectsEmptyAndOversizedPaths() public {
        UniswapV4ExactOutputAdapter.RouteConfig[] memory routes = _routes(address(input), address(output), ROUTE_ID);
        routes[0].path = new UniswapV4ExactOutputAdapter.HopConfig[](0);
        vm.expectRevert(abi.encodeWithSelector(UniswapV4ExactOutputAdapter.InvalidPathLength.selector, 0));
        _newAdapter(address(input), routes);

        uint256 count = 5;
        routes = new UniswapV4ExactOutputAdapter.RouteConfig[](1);
        routes[0].id = ROUTE_ID;
        routes[0].output = address(output);
        routes[0].path = new UniswapV4ExactOutputAdapter.HopConfig[](count);
        for (uint256 i = 0; i < count; ++i) {
            MockERC20 token = i == 0 ? input : new MockERC20("Hop", "HOP");
            routes[0].path[i] = UniswapV4ExactOutputAdapter.HopConfig({
                intermediateCurrency: address(token), fee: uint24(i + 1), tickSpacing: int24(int256(i + 1))
            });
        }
        vm.expectRevert(abi.encodeWithSelector(UniswapV4ExactOutputAdapter.InvalidPathLength.selector, count));
        _newAdapter(address(input), routes);
    }

    function _deployAdapter(address inputToken, address outputToken, bytes32 routeId)
        internal
        returns (UniswapV4ExactOutputAdapter deployed)
    {
        return _newAdapter(inputToken, _routes(inputToken, outputToken, routeId));
    }

    function _newAdapter(address inputToken, UniswapV4ExactOutputAdapter.RouteConfig[] memory routes)
        internal
        returns (UniswapV4ExactOutputAdapter deployed)
    {
        return new UniswapV4ExactOutputAdapter(
            inputToken, address(universalRouter), address(permit2), address(quoter), routes
        );
    }

    function _routes(address inputToken, address outputToken, bytes32 routeId)
        internal
        view
        returns (UniswapV4ExactOutputAdapter.RouteConfig[] memory routes)
    {
        routes = new UniswapV4ExactOutputAdapter.RouteConfig[](1);
        routes[0].id = routeId;
        routes[0].output = outputToken;
        routes[0].path = new UniswapV4ExactOutputAdapter.HopConfig[](2);
        routes[0].path[0] =
            UniswapV4ExactOutputAdapter.HopConfig({intermediateCurrency: inputToken, fee: 2, tickSpacing: 1});
        routes[0].path[1] = UniswapV4ExactOutputAdapter.HopConfig({
            intermediateCurrency: address(bridge), fee: 20_000, tickSpacing: 400
        });
    }
}
