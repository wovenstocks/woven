// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {UniswapV4ExactOutputAdapter} from "../../src/adapters/UniswapV4ExactOutputAdapter.sol";

interface IPermit2ForkView {
    function allowance(address owner, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}

/// @notice Optional executable smoke test for the live hook-free BSC v4 routes.
/// @dev Default test runs stay RPC-independent. Enable explicitly with:
///      RUN_BSC_V4_FORK=true BSC_RPC_URL=<rpc> forge test \
///      --match-path test/fork/UniswapV4BscFork.t.sol -vv
contract UniswapV4BscForkTest is Test {
    uint256 internal constant BSC_CHAIN_ID = 56;
    uint256 internal constant EXACT_OUTPUT = 1e16;
    uint256 internal constant USER_INPUT = 100_000e18;

    address internal constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant NVDAB = 0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436;
    address internal constant TSLAB = 0x5b1910eAaD6450E50f816082Aa078C41F10C292f;

    // Current official UniversalRouterV2_1_1 in Uniswap/universal-router deploy-addresses/bsc.json.
    address internal constant CURRENT_UNIVERSAL_ROUTER = 0x8B844f885672f333Bc0042cB669255f93a4C1E6b;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant V4_QUOTER = 0x9F75dD27D6664c475B90e105573E550ff69437B0;

    bytes32 internal constant NVDAB_ROUTE_ID = keccak256("WOVEN:UNISWAP_V4:USDC:USDT:NVDAB:1");
    bytes32 internal constant TSLAB_ROUTE_ID = keccak256("WOVEN:UNISWAP_V4:USDC:USDT:TSLAB:1");

    bool internal forkEnabled;
    address internal universalRouter;
    address internal user = makeAddr("fork-user");
    UniswapV4ExactOutputAdapter internal adapter;

    function setUp() public {
        forkEnabled = vm.envOr("RUN_BSC_V4_FORK", false);
        if (!forkEnabled) return;

        string memory rpcUrl = vm.envString("BSC_RPC_URL");
        uint256 requestedBlock = vm.envOr("BSC_V4_FORK_BLOCK", uint256(0));
        if (requestedBlock == 0) {
            vm.createSelectFork(rpcUrl);
        } else {
            vm.createSelectFork(rpcUrl, requestedBlock);
        }
        assertEq(block.chainid, BSC_CHAIN_ID);

        universalRouter = vm.envOr("BSC_V4_UNIVERSAL_ROUTER", CURRENT_UNIVERSAL_ROUTER);
        assertGt(USDC.code.length, 0);
        assertGt(USDT.code.length, 0);
        assertGt(NVDAB.code.length, 0);
        assertGt(TSLAB.code.length, 0);
        assertGt(universalRouter.code.length, 0);
        assertGt(PERMIT2.code.length, 0);
        assertGt(V4_QUOTER.code.length, 0);

        adapter = new UniswapV4ExactOutputAdapter(USDC, universalRouter, PERMIT2, V4_QUOTER, _liveRoutes());
        deal(USDC, user, USER_INPUT, true);
        vm.prank(user);
        IERC20(USDC).approve(address(adapter), type(uint256).max);
    }

    function testFork_quoteAndSwapExactNvdabThroughUsdt() public {
        if (!forkEnabled) return;
        _assertLiveQuoteAndSwap(NVDAB, NVDAB_ROUTE_ID);
    }

    function testFork_quoteAndSwapExactTslabThroughUsdt() public {
        if (!forkEnabled) return;
        _assertLiveQuoteAndSwap(TSLAB, TSLAB_ROUTE_ID);
    }

    function _assertLiveQuoteAndSwap(address tokenOut, bytes32 routeId) internal {
        (uint256 quotedInput, uint256 gasEstimate) = adapter.quoteExactOutput(tokenOut, EXACT_OUTPUT, routeId);
        assertGt(quotedInput, 0);
        assertGt(gasEstimate, 0);
        assertLt(quotedInput, USER_INPUT);

        uint256 maximumInput = quotedInput + ((quotedInput * 1_000) / 10_000) + 1;
        uint256 inputBefore = IERC20(USDC).balanceOf(user);
        uint256 outputBefore = IERC20(tokenOut).balanceOf(user);

        vm.prank(user);
        uint256 amountIn =
            adapter.swapExactOutput(tokenOut, EXACT_OUTPUT, maximumInput, block.timestamp + 5 minutes, routeId);

        assertEq(amountIn, quotedInput);
        assertLe(amountIn, maximumInput);
        assertEq(inputBefore - IERC20(USDC).balanceOf(user), amountIn);
        assertEq(IERC20(tokenOut).balanceOf(user) - outputBefore, EXACT_OUTPUT);
        assertEq(IERC20(USDC).balanceOf(address(adapter)), 0);
        assertEq(IERC20(tokenOut).balanceOf(address(adapter)), 0);
        assertEq(IERC20(USDC).allowance(address(adapter), PERMIT2), 0);
        (uint160 permitAmount,,) = IPermit2ForkView(PERMIT2).allowance(address(adapter), USDC, universalRouter);
        assertEq(permitAmount, 0);

        emit log_named_uint("BSC fork block", block.number);
        emit log_named_uint("Quoted and spent USDC", amountIn);
        emit log_named_address("Universal Router", universalRouter);
    }

    function _liveRoutes() internal pure returns (UniswapV4ExactOutputAdapter.RouteConfig[] memory routes) {
        routes = new UniswapV4ExactOutputAdapter.RouteConfig[](2);

        routes[0].id = NVDAB_ROUTE_ID;
        routes[0].output = NVDAB;
        routes[0].path = new UniswapV4ExactOutputAdapter.HopConfig[](2);
        routes[0].path[0] = UniswapV4ExactOutputAdapter.HopConfig({intermediateCurrency: USDC, fee: 2, tickSpacing: 1});
        routes[0].path[1] =
            UniswapV4ExactOutputAdapter.HopConfig({intermediateCurrency: USDT, fee: 20_000, tickSpacing: 400});

        routes[1].id = TSLAB_ROUTE_ID;
        routes[1].output = TSLAB;
        routes[1].path = new UniswapV4ExactOutputAdapter.HopConfig[](2);
        routes[1].path[0] = UniswapV4ExactOutputAdapter.HopConfig({intermediateCurrency: USDC, fee: 2, tickSpacing: 1});
        routes[1].path[1] =
            UniswapV4ExactOutputAdapter.HopConfig({intermediateCurrency: USDT, fee: 105, tickSpacing: 10});
    }
}
