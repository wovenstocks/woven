// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BasketFactory, ICreatorLicense, ICanonicalAssetRegistry} from "../../src/BasketFactory.sol";
import {BasketToken} from "../../src/BasketToken.sol";
import {CanonicalAssetRegistry} from "../../src/CanonicalAssetRegistry.sol";
import {CuratorGuardian} from "../../src/CuratorGuardian.sol";
import {FeeSplitter} from "../../src/FeeSplitter.sol";
import {OneClickBasketRouter} from "../../src/OneClickBasketRouter.sol";
import {PancakeV3ExactOutputAdapter} from "../../src/adapters/PancakeV3ExactOutputAdapter.sol";
import {UniswapV4ExactOutputAdapter} from "../../src/adapters/UniswapV4ExactOutputAdapter.sol";

interface IPermit2CoreFourForkView {
    function allowance(address owner, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}

interface ICoreFourScaledAssetForkView {
    function fromUIAmount(uint256 uiAmount) external view returns (uint256);

    function toUIAmount(uint256 rawAmount) external view returns (uint256);
}

contract AlwaysLicensedCreator is ICreatorLicense {
    function isLicensed(address) external pure returns (bool) {
        return true;
    }
}

/// @notice Optional end-to-end fork test for the complete initial CORE4 flow.
/// @dev Default tests remain RPC-independent. Enable explicitly with:
///      RUN_BSC_CORE4_FORK=true BSC_RPC_URL=<rpc> forge test \
///      --match-path test/fork/CoreFourRouterBscFork.t.sol -vv
contract CoreFourRouterBscForkTest is Test {
    uint256 internal constant BSC_CHAIN_ID = 56;
    uint256 internal constant ONE_BASKET = 1e18;
    uint256 internal constant DISPLAYED_UNIT_PER_ASSET = 1e16;
    uint256 internal constant USER_INPUT = 100e18;
    uint256 internal constant SLIPPAGE_BPS = 100;

    address internal constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant NVDAB = 0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436;
    address internal constant MSFTB = 0x80106cb3EAD06659A5ad19DF39D9b4733863B9b0;
    address internal constant TSLAB = 0x5b1910eAaD6450E50f816082Aa078C41F10C292f;
    address internal constant QQQB = 0x205812CdBed920aFf76C6580abD681a46D11efc7;

    address internal constant PANCAKE_V3_ROUTER = 0x13f4EA83D0bd40E75C8222255bc855a974568Dd4;
    address internal constant PANCAKE_V3_QUOTER = 0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997;
    address internal constant UNISWAP_UNIVERSAL_ROUTER = 0x8B844f885672f333Bc0042cB669255f93a4C1E6b;
    address internal constant UNISWAP_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant UNISWAP_V4_QUOTER = 0x9F75dD27D6664c475B90e105573E550ff69437B0;

    bytes32 internal constant NVDAB_ROUTE_ID = keccak256("WOVEN:UNISWAP_V4:USDC:USDT:NVDAB:1");
    bytes32 internal constant MSFTB_ROUTE_ID = keccak256("WOVEN:PANCAKE_V3:USDC:USDT:MSFTB:1");
    bytes32 internal constant TSLAB_ROUTE_ID = keccak256("WOVEN:UNISWAP_V4:USDC:USDT:TSLAB:1");
    bytes32 internal constant QQQB_ROUTE_ID = keccak256("WOVEN:PANCAKE_V3:USDC:USDT:QQQB:1");

    bool internal forkEnabled;
    address internal user = makeAddr("core4-fork-user");
    address internal treasury = makeAddr("core4-fork-treasury");

    BasketFactory internal factory;
    BasketToken internal basket;
    FeeSplitter internal splitter;
    OneClickBasketRouter internal buyRouter;
    UniswapV4ExactOutputAdapter internal v4Adapter;
    PancakeV3ExactOutputAdapter internal v3Adapter;
    mapping(address asset => uint256 unit) internal rawUnitPerAsset;

    function setUp() public {
        forkEnabled = vm.envOr("RUN_BSC_CORE4_FORK", false);
        if (!forkEnabled) return;

        string memory rpcUrl = vm.envString("BSC_RPC_URL");
        uint256 requestedBlock = vm.envOr("BSC_CORE4_FORK_BLOCK", uint256(0));
        if (requestedBlock == 0) vm.createSelectFork(rpcUrl);
        else vm.createSelectFork(rpcUrl, requestedBlock);
        assertEq(block.chainid, BSC_CHAIN_ID);

        CanonicalAssetRegistry registry = new CanonicalAssetRegistry(address(this));
        address[] memory assets = _assets();
        registry.setAssets(assets, true);

        splitter = new FeeSplitter(treasury);
        CuratorGuardian guardian = new CuratorGuardian(address(this));
        factory = new BasketFactory(
            ICreatorLicense(address(new AlwaysLicensedCreator())),
            ICanonicalAssetRegistry(address(registry)),
            splitter,
            address(guardian)
        );
        splitter.initFactory(address(factory));

        uint256[] memory units = new uint256[](4);
        for (uint256 i = 0; i < units.length; ++i) {
            ICoreFourScaledAssetForkView asset = ICoreFourScaledAssetForkView(assets[i]);
            units[i] = asset.fromUIAmount(DISPLAYED_UNIT_PER_ASSET);
            assertGt(units[i], 0, "zero CORE4 raw unit");
            assertEq(asset.toUIAmount(units[i]), DISPLAYED_UNIT_PER_ASSET, "inexact CORE4 displayed unit");
            rawUnitPerAsset[assets[i]] = units[i];
        }
        basket = BasketToken(factory.createBasket("Woven Core Four", "CORE4", assets, units, 30, factory.STARTER_CAP()));

        v4Adapter = new UniswapV4ExactOutputAdapter(
            USDC, UNISWAP_UNIVERSAL_ROUTER, UNISWAP_PERMIT2, UNISWAP_V4_QUOTER, _v4Routes()
        );
        v3Adapter = new PancakeV3ExactOutputAdapter(USDC, PANCAKE_V3_ROUTER, PANCAKE_V3_QUOTER, _v3Routes());
        address[] memory adapters = new address[](2);
        adapters[0] = address(v4Adapter);
        adapters[1] = address(v3Adapter);
        buyRouter = new OneClickBasketRouter(USDC, address(factory), adapters);

        deal(USDC, user, USER_INPUT, true);
        vm.prank(user);
        IERC20(USDC).approve(address(buyRouter), type(uint256).max);
    }

    function testFork_buysAllFourAssetsAndMintsCoreFourAtomically() public {
        if (!forkEnabled) return;

        OneClickBasketRouter.SwapLeg[] memory legs = new OneClickBasketRouter.SwapLeg[](4);
        uint256 expectedTotal;
        uint256 maxTotal;
        (legs[0], expectedTotal, maxTotal) =
            _quoteLeg(NVDAB, address(v4Adapter), NVDAB_ROUTE_ID, expectedTotal, maxTotal);
        (legs[1], expectedTotal, maxTotal) =
            _quoteLeg(MSFTB, address(v3Adapter), MSFTB_ROUTE_ID, expectedTotal, maxTotal);
        (legs[2], expectedTotal, maxTotal) =
            _quoteLeg(TSLAB, address(v4Adapter), TSLAB_ROUTE_ID, expectedTotal, maxTotal);
        (legs[3], expectedTotal, maxTotal) = _quoteLeg(QQQB, address(v3Adapter), QQQB_ROUTE_ID, expectedTotal, maxTotal);

        uint256 userUsdcBefore = IERC20(USDC).balanceOf(user);
        vm.prank(user);
        (uint256 netBasketOut, uint256 usdcSpent) = buyRouter.mintWithUsdc(
            address(basket), ONE_BASKET, 997e15, user, maxTotal, block.timestamp + 5 minutes, legs
        );

        assertEq(netBasketOut, 997e15);
        assertEq(basket.balanceOf(user), 997e15);
        assertEq(basket.balanceOf(address(splitter)), 3e15);
        assertEq(basket.totalSupply(), ONE_BASKET);
        assertGt(usdcSpent, 0);
        assertLe(usdcSpent, maxTotal);
        assertEq(userUsdcBefore - IERC20(USDC).balanceOf(user), usdcSpent);
        assertTrue(basket.isFullyBacked());

        address[] memory assets = _assets();
        for (uint256 i = 0; i < assets.length; ++i) {
            assertEq(IERC20(assets[i]).balanceOf(address(basket)), rawUnitPerAsset[assets[i]]);
            assertEq(IERC20(assets[i]).balanceOf(address(buyRouter)), 0);
        }
        assertEq(IERC20(USDC).balanceOf(address(buyRouter)), 0);
        assertEq(IERC20(USDC).balanceOf(address(v4Adapter)), 0);
        assertEq(IERC20(USDC).balanceOf(address(v3Adapter)), 0);
        assertEq(IERC20(USDC).allowance(address(v4Adapter), UNISWAP_PERMIT2), 0);
        assertEq(IERC20(USDC).allowance(address(v3Adapter), PANCAKE_V3_ROUTER), 0);
        (uint160 permitAmount,,) =
            IPermit2CoreFourForkView(UNISWAP_PERMIT2).allowance(address(v4Adapter), USDC, UNISWAP_UNIVERSAL_ROUTER);
        assertEq(permitAmount, 0);

        emit log_named_uint("BSC CORE4 fork block", block.number);
        emit log_named_uint("CORE4 expected USDC", expectedTotal);
        emit log_named_uint("CORE4 spent USDC", usdcSpent);
    }

    function _quoteLeg(address token, address adapter, bytes32 routeId, uint256 expectedTotal, uint256 maxTotal)
        internal
        returns (OneClickBasketRouter.SwapLeg memory leg, uint256 newExpectedTotal, uint256 newMaxTotal)
    {
        uint256 rawUnit = rawUnitPerAsset[token];
        uint256 amountIn;
        if (adapter == address(v4Adapter)) (amountIn,) = v4Adapter.quoteExactOutput(token, rawUnit, routeId);
        else (amountIn,) = v3Adapter.quoteExactOutput(token, rawUnit, routeId);
        uint256 maximum = (amountIn * (10_000 + SLIPPAGE_BPS) + 9_999) / 10_000;
        leg = OneClickBasketRouter.SwapLeg({
            expectedToken: token, adapter: adapter, routeId: routeId, expectedAmountOut: rawUnit, maxUsdcIn: maximum
        });
        newExpectedTotal = expectedTotal + amountIn;
        newMaxTotal = maxTotal + maximum;
    }

    function _assets() internal pure returns (address[] memory assets) {
        assets = new address[](4);
        assets[0] = NVDAB;
        assets[1] = MSFTB;
        assets[2] = TSLAB;
        assets[3] = QQQB;
    }

    function _v4Routes() internal pure returns (UniswapV4ExactOutputAdapter.RouteConfig[] memory routes) {
        routes = new UniswapV4ExactOutputAdapter.RouteConfig[](2);
        routes[0].id = NVDAB_ROUTE_ID;
        routes[0].output = NVDAB;
        routes[0].path = _v4Path(20_000, 400);
        routes[1].id = TSLAB_ROUTE_ID;
        routes[1].output = TSLAB;
        routes[1].path = _v4Path(105, 10);
    }

    function _v4Path(uint24 stockFee, int24 stockSpacing)
        internal
        pure
        returns (UniswapV4ExactOutputAdapter.HopConfig[] memory path)
    {
        path = new UniswapV4ExactOutputAdapter.HopConfig[](2);
        path[0] = UniswapV4ExactOutputAdapter.HopConfig({intermediateCurrency: USDC, fee: 2, tickSpacing: 1});
        path[1] = UniswapV4ExactOutputAdapter.HopConfig({
            intermediateCurrency: USDT, fee: stockFee, tickSpacing: stockSpacing
        });
    }

    function _v3Routes() internal pure returns (PancakeV3ExactOutputAdapter.RouteConfig[] memory routes) {
        routes = new PancakeV3ExactOutputAdapter.RouteConfig[](2);
        routes[0] = PancakeV3ExactOutputAdapter.RouteConfig({
            id: MSFTB_ROUTE_ID, path: abi.encodePacked(MSFTB, uint24(2_500), USDT, uint24(100), USDC)
        });
        routes[1] = PancakeV3ExactOutputAdapter.RouteConfig({
            id: QQQB_ROUTE_ID, path: abi.encodePacked(QQQB, uint24(100), USDT, uint24(100), USDC)
        });
    }
}
