// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {PancakeV2ExactOutputAdapter} from "../src/adapters/PancakeV2ExactOutputAdapter.sol";
import {PancakeV3ExactOutputAdapter} from "../src/adapters/PancakeV3ExactOutputAdapter.sol";
import {DirectionalRefundFeeToken, DirectionalSenderSurchargeToken} from "./mocks/DirectionalFeeTokens.sol";
import {FeeOnTransferToken, MockERC20} from "./mocks/MockERC20.sol";
import {MockPancakeV2Router, MockPancakeV3Quoter, MockPancakeV3Router} from "./mocks/MockPancakeDependencies.sol";

contract PancakeV2ExactOutputAdapterTest is Test {
    uint256 internal constant EXACT_OUTPUT = 10e18;
    uint256 internal constant QUOTED_INPUT = 41e6;
    uint256 internal constant ACTUAL_INPUT = 42e6;
    uint256 internal constant MAX_INPUT = 50e6;
    uint256 internal constant USER_INPUT = 1_000e6;
    bytes32 internal constant ROUTE_ID = keccak256("PANCAKE_V2_USDC_STOCK");
    bytes32 internal constant UNKNOWN_ROUTE_ID = keccak256("UNKNOWN");

    address internal user = makeAddr("v2-user");
    MockERC20 internal input;
    MockERC20 internal bridge;
    MockERC20 internal output;
    MockPancakeV2Router internal dexRouter;
    PancakeV2ExactOutputAdapter internal adapter;
    address[] internal configuredPath;

    function setUp() public {
        input = new MockERC20("USD Coin", "USDC");
        bridge = new MockERC20("Wrapped BNB", "WBNB");
        output = new MockERC20("Stock", "STOCKB");
        dexRouter = new MockPancakeV2Router();

        configuredPath.push(address(input));
        configuredPath.push(address(bridge));
        configuredPath.push(address(output));
        dexRouter.setExpectedPath(keccak256(abi.encode(configuredPath)));
        dexRouter.configureQuote(QUOTED_INPUT);
        dexRouter.configureSwap(ACTUAL_INPUT, ACTUAL_INPUT, 0);

        adapter = _deploy(address(input), address(output), ROUTE_ID, configuredPath);
        input.mint(user, USER_INPUT);
        output.mint(address(dexRouter), 1_000_000e18);
        vm.prank(user);
        input.approve(address(adapter), type(uint256).max);
    }

    function test_routeUsesTypedAddressArrayAndQuoteUsesPinnedPath() public view {
        bytes32[] memory ids = adapter.routeIds();
        address[] memory route = adapter.route(ROUTE_ID);
        assertEq(ids.length, 1);
        assertEq(ids[0], ROUTE_ID);
        assertEq(route.length, configuredPath.length);
        for (uint256 i = 0; i < route.length; ++i) {
            assertEq(route[i], configuredPath[i]);
        }
        assertEq(adapter.routeOutput(ROUTE_ID), address(output));
        assertEq(adapter.routeHash(ROUTE_ID), keccak256(abi.encode(configuredPath)));

        (uint256 amountIn, uint256 gasEstimate) = adapter.quoteExactOutput(address(output), EXACT_OUTPUT, ROUTE_ID);
        assertEq(amountIn, QUOTED_INPUT);
        assertEq(gasEstimate, 0);
    }

    function test_swapExactOutputRefundsOnlySessionFundsPreservesDustAndClearsAllowance() public {
        uint256 inputDust = 7e6;
        uint256 outputDust = 3e18;
        input.mint(address(adapter), inputDust);
        output.mint(address(adapter), outputDust);
        uint256 deadline = block.timestamp + 5 minutes;

        vm.prank(user);
        uint256 amountIn = adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, deadline, ROUTE_ID);

        assertEq(amountIn, ACTUAL_INPUT);
        assertEq(input.balanceOf(user), USER_INPUT - ACTUAL_INPUT);
        assertEq(output.balanceOf(user), EXACT_OUTPUT);
        assertEq(input.balanceOf(address(adapter)), inputDust);
        assertEq(output.balanceOf(address(adapter)), outputDust);
        assertEq(input.allowance(address(adapter), address(dexRouter)), 0);
        assertEq(input.balanceOf(address(dexRouter)), ACTUAL_INPUT);
        assertEq(dexRouter.lastPathHash(), keccak256(abi.encode(configuredPath)));
        assertEq(dexRouter.lastRecipient(), user);
        assertEq(dexRouter.lastAmountOut(), EXACT_OUTPUT);
        assertEq(dexRouter.lastAmountInMaximum(), MAX_INPUT);
        assertEq(dexRouter.lastDeadline(), deadline);
    }

    function test_routerCodehashChangeBlocksQuoteAndSwapBeforeFundsMove() public {
        bytes32 expected = adapter.dexRouterCodehash();
        vm.etch(address(dexRouter), hex"60006000fd");
        bytes32 actual = address(dexRouter).codehash;

        vm.expectRevert(abi.encodeWithSelector(PancakeV2ExactOutputAdapter.DexCodeChanged.selector, expected, actual));
        adapter.quoteExactOutput(address(output), EXACT_OUTPUT, ROUTE_ID);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(PancakeV2ExactOutputAdapter.DexCodeChanged.selector, expected, actual));
        adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);
        assertEq(input.balanceOf(user), USER_INPUT);
    }

    function test_rejectsFeeOnTransferInputAtomically() public {
        FeeOnTransferToken taxedInput = new FeeOnTransferToken();
        address[] memory path = _path(address(taxedInput), address(bridge), address(output));
        dexRouter.setExpectedPath(keccak256(abi.encode(path)));
        PancakeV2ExactOutputAdapter taxedAdapter = _deploy(address(taxedInput), address(output), ROUTE_ID, path);
        taxedInput.mint(user, USER_INPUT);
        vm.prank(user);
        taxedInput.approve(address(taxedAdapter), MAX_INPUT);
        uint256 received = MAX_INPUT - (MAX_INPUT / 100);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(PancakeV2ExactOutputAdapter.InexactInputTransfer.selector, MAX_INPUT, received)
        );
        taxedAdapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);

        assertEq(taxedInput.balanceOf(user), USER_INPUT);
        assertEq(taxedInput.balanceOf(address(taxedAdapter)), 0);
        assertEq(taxedInput.allowance(address(taxedAdapter), address(dexRouter)), 0);
    }

    function test_rejectsFeeOnTransferOutputAndRollsBackDexTransfers() public {
        FeeOnTransferToken taxedOutput = new FeeOnTransferToken();
        address[] memory path = _path(address(input), address(bridge), address(taxedOutput));
        dexRouter.setExpectedPath(keccak256(abi.encode(path)));
        PancakeV2ExactOutputAdapter taxedAdapter = _deploy(address(input), address(taxedOutput), ROUTE_ID, path);
        taxedOutput.mint(address(dexRouter), EXACT_OUTPUT);
        vm.prank(user);
        input.approve(address(taxedAdapter), MAX_INPUT);
        uint256 received = EXACT_OUTPUT - (EXACT_OUTPUT / 100);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(PancakeV2ExactOutputAdapter.OutputAmountMismatch.selector, EXACT_OUTPUT, received)
        );
        taxedAdapter.swapExactOutput(
            address(taxedOutput), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID
        );

        assertEq(input.balanceOf(user), USER_INPUT);
        assertEq(input.balanceOf(address(dexRouter)), 0);
        assertEq(taxedOutput.balanceOf(user), 0);
        assertEq(taxedOutput.balanceOf(address(dexRouter)), EXACT_OUTPUT);
        assertEq(input.allowance(address(taxedAdapter), address(dexRouter)), 0);
    }

    function test_rejectsCallerSurchargeEvenWhenV2AdapterReceivesExactMaximum() public {
        DirectionalSenderSurchargeToken surchargeInput = new DirectionalSenderSurchargeToken();
        surchargeInput.setSurchargedSender(user);
        address[] memory path = _path(address(surchargeInput), address(bridge), address(output));
        dexRouter.setExpectedPath(keccak256(abi.encode(path)));
        PancakeV2ExactOutputAdapter surchargeAdapter = _deploy(address(surchargeInput), address(output), ROUTE_ID, path);
        surchargeInput.mint(user, USER_INPUT);
        vm.prank(user);
        surchargeInput.approve(address(surchargeAdapter), MAX_INPUT);
        uint256 callerDebit = MAX_INPUT + (MAX_INPUT / 100);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(PancakeV2ExactOutputAdapter.InexactCallerDebit.selector, MAX_INPUT, callerDebit)
        );
        surchargeAdapter.swapExactOutput(
            address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID
        );

        assertEq(surchargeInput.balanceOf(user), USER_INPUT);
        assertEq(surchargeInput.balanceOf(address(surchargeAdapter)), 0);
    }

    function test_rejectsTaxedOutboundV2Refund() public {
        DirectionalRefundFeeToken refundFeeInput = new DirectionalRefundFeeToken();
        address[] memory path = _path(address(refundFeeInput), address(bridge), address(output));
        dexRouter.setExpectedPath(keccak256(abi.encode(path)));
        PancakeV2ExactOutputAdapter refundAdapter = _deploy(address(refundFeeInput), address(output), ROUTE_ID, path);
        refundFeeInput.setTaxedSender(address(refundAdapter));
        refundFeeInput.mint(user, USER_INPUT);
        vm.prank(user);
        refundFeeInput.approve(address(refundAdapter), MAX_INPUT);

        uint256 refund = MAX_INPUT - ACTUAL_INPUT;
        uint256 received = refund - (refund / 100);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(PancakeV2ExactOutputAdapter.InexactRefund.selector, refund, received));
        refundAdapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);

        assertEq(refundFeeInput.balanceOf(user), USER_INPUT);
        assertEq(refundFeeInput.balanceOf(address(refundAdapter)), 0);
        assertEq(output.balanceOf(user), 0);
    }

    function test_slippageDeadlineAndInvalidRoutesFailClosed() public {
        dexRouter.configureSwap(MAX_INPUT + 1, MAX_INPUT + 1, 0);
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(MockPancakeV2Router.ExcessiveInputAmount.selector, MAX_INPUT + 1, MAX_INPUT)
        );
        adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);

        vm.warp(1_000_000);
        vm.prank(user);
        vm.expectRevert(PancakeV2ExactOutputAdapter.Expired.selector);
        adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp - 1, ROUTE_ID);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(PancakeV2ExactOutputAdapter.RouteNotFound.selector, UNKNOWN_ROUTE_ID));
        adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, UNKNOWN_ROUTE_ID);

        vm.expectRevert(
            abi.encodeWithSelector(
                PancakeV2ExactOutputAdapter.RouteOutputMismatch.selector, address(output), address(input)
            )
        );
        adapter.quoteExactOutput(address(input), EXACT_OUTPUT, ROUTE_ID);
        assertEq(input.balanceOf(user), USER_INPUT);
    }

    function test_routerFailureAfterTransfersRollsBackEntireSwap() public {
        dexRouter.setFailures(false, false, true);
        uint256 routerOutputBefore = output.balanceOf(address(dexRouter));

        vm.prank(user);
        vm.expectRevert(MockPancakeV2Router.ForcedFailure.selector);
        adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);

        assertEq(input.balanceOf(user), USER_INPUT);
        assertEq(output.balanceOf(user), 0);
        assertEq(input.balanceOf(address(adapter)), 0);
        assertEq(input.balanceOf(address(dexRouter)), 0);
        assertEq(output.balanceOf(address(dexRouter)), routerOutputBefore);
        assertEq(input.allowance(address(adapter), address(dexRouter)), 0);
    }

    function test_constructorRejectsMalformedAndUnboundPaths() public {
        address[] memory tooShort = new address[](1);
        tooShort[0] = address(input);
        vm.expectRevert(abi.encodeWithSelector(PancakeV2ExactOutputAdapter.InvalidPathLength.selector, 1));
        _deploy(address(input), address(output), ROUTE_ID, tooShort);

        address[] memory wrongInput = _path(address(bridge), address(input), address(output));
        vm.expectRevert(PancakeV2ExactOutputAdapter.InvalidPathEndpoint.selector);
        _deploy(address(input), address(output), ROUTE_ID, wrongInput);

        address[] memory duplicate = _path(address(input), address(bridge), address(input));
        vm.expectRevert(abi.encodeWithSelector(PancakeV2ExactOutputAdapter.DuplicatePathToken.selector, address(input)));
        _deploy(address(input), address(input), ROUTE_ID, duplicate);
    }

    function _deploy(address inputToken, address, bytes32 routeId, address[] memory path)
        internal
        returns (PancakeV2ExactOutputAdapter deployed)
    {
        PancakeV2ExactOutputAdapter.RouteConfig[] memory routes = new PancakeV2ExactOutputAdapter.RouteConfig[](1);
        routes[0] = PancakeV2ExactOutputAdapter.RouteConfig({id: routeId, path: path});
        deployed = new PancakeV2ExactOutputAdapter(inputToken, address(dexRouter), routes);
    }

    function _path(address tokenIn, address middle, address tokenOut) internal pure returns (address[] memory path) {
        path = new address[](3);
        path[0] = tokenIn;
        path[1] = middle;
        path[2] = tokenOut;
    }
}

contract PancakeV3ExactOutputAdapterTest is Test {
    uint256 internal constant EXACT_OUTPUT = 10e18;
    uint256 internal constant QUOTED_INPUT = 39e6;
    uint256 internal constant ACTUAL_INPUT = 40e6;
    uint256 internal constant MAX_INPUT = 50e6;
    uint256 internal constant USER_INPUT = 1_000e6;
    uint256 internal constant QUOTE_GAS = 172_000;
    bytes32 internal constant ROUTE_ID = keccak256("PANCAKE_V3_USDC_STOCK");
    bytes32 internal constant UNKNOWN_ROUTE_ID = keccak256("UNKNOWN");

    address internal user = makeAddr("v3-user");
    MockERC20 internal input;
    MockERC20 internal bridge;
    MockERC20 internal output;
    MockPancakeV3Router internal dexRouter;
    MockPancakeV3Quoter internal quoter;
    PancakeV3ExactOutputAdapter internal adapter;
    bytes internal configuredPath;

    function setUp() public {
        input = new MockERC20("USD Coin", "USDC");
        bridge = new MockERC20("Wrapped BNB", "WBNB");
        output = new MockERC20("Stock", "STOCKB");
        dexRouter = new MockPancakeV3Router(address(input));
        quoter = new MockPancakeV3Quoter();

        configuredPath = _path(address(output), 500, address(bridge), 2_500, address(input));
        dexRouter.setExpectedPath(keccak256(configuredPath));
        dexRouter.configureSwap(ACTUAL_INPUT, ACTUAL_INPUT, 0);
        quoter.setExpectedPath(keccak256(configuredPath));
        quoter.configureQuote(QUOTED_INPUT, QUOTE_GAS);

        adapter = _deploy(address(input), ROUTE_ID, configuredPath);
        input.mint(user, USER_INPUT);
        output.mint(address(dexRouter), 1_000_000e18);
        vm.prank(user);
        input.approve(address(adapter), type(uint256).max);
    }

    function test_routeUsesTypedReverseV3PathAndQuoteUsesExactEncoding() public {
        bytes32[] memory ids = adapter.routeIds();
        bytes memory storedPath = adapter.route(ROUTE_ID);
        assertEq(ids.length, 1);
        assertEq(ids[0], ROUTE_ID);
        assertEq(storedPath, configuredPath);
        assertEq(adapter.routeOutput(ROUTE_ID), address(output));
        assertEq(adapter.routeHash(ROUTE_ID), keccak256(configuredPath));

        (uint256 amountIn, uint256 gasEstimate) = adapter.quoteExactOutput(address(output), EXACT_OUTPUT, ROUTE_ID);
        assertEq(amountIn, QUOTED_INPUT);
        assertEq(gasEstimate, QUOTE_GAS);
        assertEq(quoter.lastPathHash(), keccak256(configuredPath));
        assertEq(quoter.lastAmountOut(), EXACT_OUTPUT);
    }

    function test_swapExactOutputRefundsOnlySessionFundsPreservesDustAndClearsAllowance() public {
        uint256 inputDust = 9e6;
        uint256 outputDust = 2e18;
        input.mint(address(adapter), inputDust);
        output.mint(address(adapter), outputDust);

        vm.prank(user);
        uint256 amountIn =
            adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);

        assertEq(amountIn, ACTUAL_INPUT);
        assertEq(input.balanceOf(user), USER_INPUT - ACTUAL_INPUT);
        assertEq(output.balanceOf(user), EXACT_OUTPUT);
        assertEq(input.balanceOf(address(adapter)), inputDust);
        assertEq(output.balanceOf(address(adapter)), outputDust);
        assertEq(input.allowance(address(adapter), address(dexRouter)), 0);
        assertEq(input.balanceOf(address(dexRouter)), ACTUAL_INPUT);
        assertEq(dexRouter.lastPathHash(), keccak256(configuredPath));
        assertEq(dexRouter.lastRecipient(), user);
        assertEq(dexRouter.lastAmountOut(), EXACT_OUTPUT);
        assertEq(dexRouter.lastAmountInMaximum(), MAX_INPUT);
    }

    function test_quoterCodehashChangeBlocksQuote() public {
        bytes32 expected = adapter.quoterCodehash();
        vm.etch(address(quoter), hex"60006000fd");
        bytes32 actual = address(quoter).codehash;

        vm.expectRevert(abi.encodeWithSelector(PancakeV3ExactOutputAdapter.DexCodeChanged.selector, expected, actual));
        adapter.quoteExactOutput(address(output), EXACT_OUTPUT, ROUTE_ID);
    }

    function test_rejectsMalformedOrZeroGasQuote() public {
        quoter.setMalformedResponse(true);
        vm.expectRevert(PancakeV3ExactOutputAdapter.InvalidSwapResult.selector);
        adapter.quoteExactOutput(address(output), EXACT_OUTPUT, ROUTE_ID);

        quoter.setMalformedResponse(false);
        quoter.configureQuote(QUOTED_INPUT, 0);
        vm.expectRevert(PancakeV3ExactOutputAdapter.InvalidSwapResult.selector);
        adapter.quoteExactOutput(address(output), EXACT_OUTPUT, ROUTE_ID);
    }

    function test_routerCodehashChangeBlocksSwapBeforeFundsMove() public {
        bytes32 expected = adapter.dexRouterCodehash();
        vm.etch(address(dexRouter), hex"60006000fd");
        bytes32 actual = address(dexRouter).codehash;

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(PancakeV3ExactOutputAdapter.DexCodeChanged.selector, expected, actual));
        adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);
        assertEq(input.balanceOf(user), USER_INPUT);
    }

    function test_rejectsFeeOnTransferInputAtomically() public {
        FeeOnTransferToken taxedInput = new FeeOnTransferToken();
        MockPancakeV3Router taxedRouter = new MockPancakeV3Router(address(taxedInput));
        bytes memory path = _path(address(output), 500, address(bridge), 2_500, address(taxedInput));
        taxedRouter.setExpectedPath(keccak256(path));
        taxedRouter.configureSwap(ACTUAL_INPUT, ACTUAL_INPUT, 0);
        PancakeV3ExactOutputAdapter taxedAdapter =
            _deployWith(address(taxedInput), address(taxedRouter), address(quoter), ROUTE_ID, path);
        taxedInput.mint(user, USER_INPUT);
        vm.prank(user);
        taxedInput.approve(address(taxedAdapter), MAX_INPUT);
        uint256 received = MAX_INPUT - (MAX_INPUT / 100);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(PancakeV3ExactOutputAdapter.InexactInputTransfer.selector, MAX_INPUT, received)
        );
        taxedAdapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);

        assertEq(taxedInput.balanceOf(user), USER_INPUT);
        assertEq(taxedInput.balanceOf(address(taxedAdapter)), 0);
        assertEq(taxedInput.allowance(address(taxedAdapter), address(taxedRouter)), 0);
    }

    function test_rejectsFeeOnTransferOutputAndRollsBackDexTransfers() public {
        FeeOnTransferToken taxedOutput = new FeeOnTransferToken();
        bytes memory path = _path(address(taxedOutput), 500, address(bridge), 2_500, address(input));
        dexRouter.setExpectedPath(keccak256(path));
        PancakeV3ExactOutputAdapter taxedAdapter = _deploy(address(input), ROUTE_ID, path);
        taxedOutput.mint(address(dexRouter), EXACT_OUTPUT);
        vm.prank(user);
        input.approve(address(taxedAdapter), MAX_INPUT);
        uint256 received = EXACT_OUTPUT - (EXACT_OUTPUT / 100);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(PancakeV3ExactOutputAdapter.OutputAmountMismatch.selector, EXACT_OUTPUT, received)
        );
        taxedAdapter.swapExactOutput(
            address(taxedOutput), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID
        );

        assertEq(input.balanceOf(user), USER_INPUT);
        assertEq(input.balanceOf(address(dexRouter)), 0);
        assertEq(taxedOutput.balanceOf(user), 0);
        assertEq(taxedOutput.balanceOf(address(dexRouter)), EXACT_OUTPUT);
        assertEq(input.allowance(address(taxedAdapter), address(dexRouter)), 0);
    }

    function test_rejectsCallerSurchargeEvenWhenV3AdapterReceivesExactMaximum() public {
        DirectionalSenderSurchargeToken surchargeInput = new DirectionalSenderSurchargeToken();
        surchargeInput.setSurchargedSender(user);
        bytes memory path = _path(address(output), 500, address(bridge), 2_500, address(surchargeInput));
        MockPancakeV3Router surchargeRouter = new MockPancakeV3Router(address(surchargeInput));
        surchargeRouter.setExpectedPath(keccak256(path));
        surchargeRouter.configureSwap(ACTUAL_INPUT, ACTUAL_INPUT, 0);
        output.mint(address(surchargeRouter), EXACT_OUTPUT);
        PancakeV3ExactOutputAdapter surchargeAdapter =
            _deployWith(address(surchargeInput), address(surchargeRouter), address(quoter), ROUTE_ID, path);
        surchargeInput.mint(user, USER_INPUT);
        vm.prank(user);
        surchargeInput.approve(address(surchargeAdapter), MAX_INPUT);
        uint256 callerDebit = MAX_INPUT + (MAX_INPUT / 100);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(PancakeV3ExactOutputAdapter.InexactCallerDebit.selector, MAX_INPUT, callerDebit)
        );
        surchargeAdapter.swapExactOutput(
            address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID
        );

        assertEq(surchargeInput.balanceOf(user), USER_INPUT);
        assertEq(surchargeInput.balanceOf(address(surchargeAdapter)), 0);
    }

    function test_rejectsTaxedOutboundV3Refund() public {
        DirectionalRefundFeeToken refundFeeInput = new DirectionalRefundFeeToken();
        bytes memory path = _path(address(output), 500, address(bridge), 2_500, address(refundFeeInput));
        MockPancakeV3Router refundRouter = new MockPancakeV3Router(address(refundFeeInput));
        refundRouter.setExpectedPath(keccak256(path));
        refundRouter.configureSwap(ACTUAL_INPUT, ACTUAL_INPUT, 0);
        output.mint(address(refundRouter), EXACT_OUTPUT);
        PancakeV3ExactOutputAdapter refundAdapter =
            _deployWith(address(refundFeeInput), address(refundRouter), address(quoter), ROUTE_ID, path);
        refundFeeInput.setTaxedSender(address(refundAdapter));
        refundFeeInput.mint(user, USER_INPUT);
        vm.prank(user);
        refundFeeInput.approve(address(refundAdapter), MAX_INPUT);

        uint256 refund = MAX_INPUT - ACTUAL_INPUT;
        uint256 received = refund - (refund / 100);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(PancakeV3ExactOutputAdapter.InexactRefund.selector, refund, received));
        refundAdapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);

        assertEq(refundFeeInput.balanceOf(user), USER_INPUT);
        assertEq(refundFeeInput.balanceOf(address(refundAdapter)), 0);
        assertEq(output.balanceOf(user), 0);
    }

    function test_slippageDeadlineAndInvalidRoutesFailClosed() public {
        dexRouter.configureSwap(MAX_INPUT + 1, MAX_INPUT + 1, 0);
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(MockPancakeV3Router.ExcessiveInputAmount.selector, MAX_INPUT + 1, MAX_INPUT)
        );
        adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);

        vm.warp(1_000_000);
        vm.prank(user);
        vm.expectRevert(PancakeV3ExactOutputAdapter.Expired.selector);
        adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp - 1, ROUTE_ID);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(PancakeV3ExactOutputAdapter.RouteNotFound.selector, UNKNOWN_ROUTE_ID));
        adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, UNKNOWN_ROUTE_ID);

        vm.expectRevert(
            abi.encodeWithSelector(
                PancakeV3ExactOutputAdapter.RouteOutputMismatch.selector, address(output), address(input)
            )
        );
        adapter.quoteExactOutput(address(input), EXACT_OUTPUT, ROUTE_ID);
        assertEq(input.balanceOf(user), USER_INPUT);
    }

    function test_routerFailureAfterTransfersRollsBackEntireSwap() public {
        dexRouter.setFailures(false, true);
        uint256 routerOutputBefore = output.balanceOf(address(dexRouter));

        vm.prank(user);
        vm.expectRevert(MockPancakeV3Router.ForcedFailure.selector);
        adapter.swapExactOutput(address(output), EXACT_OUTPUT, MAX_INPUT, block.timestamp + 5 minutes, ROUTE_ID);

        assertEq(input.balanceOf(user), USER_INPUT);
        assertEq(output.balanceOf(user), 0);
        assertEq(input.balanceOf(address(adapter)), 0);
        assertEq(input.balanceOf(address(dexRouter)), 0);
        assertEq(output.balanceOf(address(dexRouter)), routerOutputBefore);
        assertEq(input.allowance(address(adapter), address(dexRouter)), 0);
    }

    function test_constructorRejectsMalformedForwardAndZeroFeePaths() public {
        bytes memory malformed = abi.encodePacked(address(output), uint24(500), address(input), bytes1(0x01));
        vm.expectRevert(
            abi.encodeWithSelector(PancakeV3ExactOutputAdapter.InvalidPathLength.selector, malformed.length)
        );
        _deploy(address(input), ROUTE_ID, malformed);

        bytes memory forward = abi.encodePacked(address(input), uint24(500), address(output));
        vm.expectRevert(PancakeV3ExactOutputAdapter.InvalidPathEndpoint.selector);
        _deploy(address(input), ROUTE_ID, forward);

        bytes memory zeroFee = abi.encodePacked(address(output), uint24(0), address(input));
        vm.expectRevert(abi.encodeWithSelector(PancakeV3ExactOutputAdapter.InvalidPoolFee.selector, 0));
        _deploy(address(input), ROUTE_ID, zeroFee);
    }

    function _deploy(address inputToken, bytes32 routeId, bytes memory path)
        internal
        returns (PancakeV3ExactOutputAdapter deployed)
    {
        return _deployWith(inputToken, address(dexRouter), address(quoter), routeId, path);
    }

    function _deployWith(address inputToken, address router, address quoteTarget, bytes32 routeId, bytes memory path)
        internal
        returns (PancakeV3ExactOutputAdapter deployed)
    {
        PancakeV3ExactOutputAdapter.RouteConfig[] memory routes = new PancakeV3ExactOutputAdapter.RouteConfig[](1);
        routes[0] = PancakeV3ExactOutputAdapter.RouteConfig({id: routeId, path: path});
        deployed = new PancakeV3ExactOutputAdapter(inputToken, router, quoteTarget, routes);
    }

    function _path(address tokenOut, uint24 feeOne, address middle, uint24 feeTwo, address tokenIn)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(tokenOut, feeOne, middle, feeTwo, tokenIn);
    }
}
