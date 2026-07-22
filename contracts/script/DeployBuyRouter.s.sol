// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {OneClickBasketRouter} from "../src/OneClickBasketRouter.sol";
import {PancakeV3ExactOutputAdapter} from "../src/adapters/PancakeV3ExactOutputAdapter.sol";
import {UniswapV4ExactOutputAdapter} from "../src/adapters/UniswapV4ExactOutputAdapter.sol";
import {DeploymentSafeProfile} from "./DeploymentSafeProfile.sol";

interface IBuyRouterFactoryProfile {
    function assetRegistry() external view returns (address);
}

interface IBuyRouterAssetRegistryProfile {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function isSupported(address asset) external view returns (bool);
}

interface IERC8056DeploymentProfile {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
    function uiMultiplier() external view returns (uint256);
    function newUIMultiplier() external view returns (uint256);
    function toUIAmount(uint256 rawAmount) external view returns (uint256);
    function fromUIAmount(uint256 uiAmount) external view returns (uint256);
}

interface IBeaconDeploymentProfile {
    function implementation() external view returns (address);
}

interface IPancakeV3DeploymentRouter {
    function factoryV2() external view returns (address);
    function factory() external view returns (address);
}

interface IPancakeV3DeploymentFactory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IPancakeV3DeploymentPool {
    function liquidity() external view returns (uint128);
}

interface IPancakeV3DeploymentQuoter {
    function factory() external view returns (address);
    function quoteExactOutput(bytes calldata path, uint256 amountOut)
        external
        returns (
            uint256 amountIn,
            uint160[] memory sqrtPriceX96AfterList,
            uint32[] memory initializedTicksCrossedList,
            uint256 gasEstimate
        );
}

interface IUniswapV4DeploymentStateView {
    function poolManager() external view returns (address);
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getLiquidity(bytes32 poolId) external view returns (uint128 liquidity);
}

interface IUniswapV4DeploymentQuoter {
    struct PathKey {
        address intermediateCurrency;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        bytes hookData;
    }

    struct QuoteExactParams {
        address exactCurrency;
        PathKey[] path;
        uint128 exactAmount;
    }

    function poolManager() external view returns (address);
    function quoteExactOutput(QuoteExactParams calldata params) external returns (uint256 amountIn, uint256 gasEstimate);
}

/// @notice Fail-closed deployment for the initial four-asset USDC buy-router.
/// @dev NVDAB and TSLAB use fixed, hook-free Uniswap v4 paths. MSFTB and
///      QQQB use fixed PancakeSwap v3 paths. The script intentionally excludes
///      the dust-sized Pancake v2 TSLAB pool and does not make TECH5 executable:
///      TECH5 also contains METAB, which has no adapter route in this deployment.
contract DeployBuyRouter is Script, DeploymentSafeProfile {
    uint256 internal constant BNB_MAINNET_CHAIN_ID = 56;
    uint256 internal constant ASSET_COUNT = 4;
    uint256 internal constant MIN_PROBE_RAW_OUTPUT = 1e16;
    uint256 internal constant ERC8056_ROUNDTRIP_INPUT = 1e18;
    uint256 internal constant V3_ADDRESS_SIZE = 20;
    uint256 internal constant V3_FEE_SIZE = 3;
    uint256 internal constant V3_NEXT_OFFSET = V3_ADDRESS_SIZE + V3_FEE_SIZE;
    uint256 internal constant V3_HOPS = 2;

    bytes4 internal constant ERC8056_CORE_INTERFACE = 0xa60bf13d;
    bytes4 internal constant ERC8056_CONVERSION_INTERFACE = 0x57854fc3;
    bytes4 internal constant ERC8056_PENDING_INTERFACE = 0x4bd27648;

    bytes32 internal constant EIP1967_IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 internal constant EIP1967_BEACON_SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;

    address internal constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant USDC_IMPLEMENTATION = 0xBA5Fe23f8a3a24BEd3236F05F2FcF35fd0BF0B5C;
    address internal constant BSTOCK_BEACON = 0x156D6dce9a4f6139a3406F1f021F1A4880De93a3;
    address internal constant BSTOCK_IMPLEMENTATION = 0xCFEd6c4679297ea4889F8183bC057B4A86C64e46;
    address internal constant NVDAB = 0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436;
    address internal constant MSFTB = 0x80106cb3EAD06659A5ad19DF39D9b4733863B9b0;
    address internal constant TSLAB = 0x5b1910eAaD6450E50f816082Aa078C41F10C292f;
    address internal constant QQQB = 0x205812CdBed920aFf76C6580abD681a46D11efc7;

    address internal constant PANCAKE_V2_FACTORY = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;
    address internal constant PANCAKE_V3_ROUTER = 0x13f4EA83D0bd40E75C8222255bc855a974568Dd4;
    address internal constant PANCAKE_V3_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    address internal constant PANCAKE_V3_QUOTER = 0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997;
    address internal constant PANCAKE_V3_MSFTB_USDT_POOL = 0x5018b018cEB7645c927c5Cf246786F89ebCbe7Ea;
    address internal constant PANCAKE_V3_QQQB_USDT_POOL = 0xe531fcb1F5a195de7608B9F4f9518544C2cdB693;
    address internal constant PANCAKE_V3_USDT_USDC_POOL = 0x92b7807bF19b7DDdf89b706143896d05228f3121;

    address internal constant UNISWAP_V4_POOL_MANAGER = 0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF;
    address internal constant UNISWAP_V4_STATE_VIEW = 0xd13Dd3D6E93f276FAfc9Db9E6BB47C1180aeE0c4;
    address internal constant UNISWAP_V4_QUOTER = 0x9F75dD27D6664c475B90e105573E550ff69437B0;
    address internal constant UNISWAP_UNIVERSAL_ROUTER_V2_1_1 = 0x8B844f885672f333Bc0042cB669255f93a4C1E6b;
    address internal constant UNISWAP_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    uint24 internal constant V4_STABLE_FEE = 2;
    int24 internal constant V4_STABLE_TICK_SPACING = 1;
    uint24 internal constant V4_NVDAB_FEE = 20_000;
    int24 internal constant V4_NVDAB_TICK_SPACING = 400;
    uint24 internal constant V4_TSLAB_FEE = 105;
    int24 internal constant V4_TSLAB_TICK_SPACING = 10;
    uint24 internal constant V3_MSFTB_FEE = 2_500;
    uint24 internal constant V3_QQQB_FEE = 100;
    uint24 internal constant V3_STABLE_FEE = 100;

    struct ProbeLimits {
        uint256[ASSET_COUNT] rawOutput;
        uint256[ASSET_COUNT] maxUsdcInput;
    }

    struct CodehashPins {
        bytes32 usdc;
        bytes32 usdt;
        bytes32 usdcImplementation;
        bytes32 bstockBeacon;
        bytes32 bstockImplementation;
        bytes32 basketFactory;
        bytes32 assetRegistry;
        bytes32[ASSET_COUNT] assets;
        bytes32 pancakeV3Router;
        bytes32 pancakeV3Factory;
        bytes32 pancakeV3Quoter;
        bytes32 pancakeV3MsftbPool;
        bytes32 pancakeV3QqqbPool;
        bytes32 pancakeV3StablePool;
        bytes32 uniswapPoolManager;
        bytes32 uniswapStateView;
        bytes32 uniswapV4Quoter;
        bytes32 uniswapUniversalRouter;
        bytes32 uniswapPermit2;
    }

    struct V4PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    function run()
        external
        returns (
            UniswapV4ExactOutputAdapter v4Adapter,
            PancakeV3ExactOutputAdapter v3Adapter,
            OneClickBasketRouter buyRouter
        )
    {
        require(vm.envBool("CONFIRM_DEPLOY"), "CONFIRM_DEPLOY must be true");
        require(vm.envBool("CONFIRM_INITIAL_FOUR_ASSET_ROUTE_SET"), "four-asset route set not confirmed");
        require(vm.envUint("EXPECTED_CHAIN_ID") == BNB_MAINNET_CHAIN_ID, "expected chain must be BNB mainnet");
        require(block.chainid == BNB_MAINNET_CHAIN_ID, "unexpected chain id");

        address basketFactory = vm.envAddress("BASKET_FACTORY");
        address assetRegistry = vm.envAddress("ASSET_REGISTRY");
        address protocolSafe = vm.envAddress("PROTOCOL_SAFE");
        address expectedSafeOwner = vm.envAddress("EXPECTED_SAFE_OWNER");
        ProbeLimits memory probes = _loadProbeLimits();
        CodehashPins memory pins = _loadCodehashPins();
        address[ASSET_COUNT] memory assets = _assets();
        bytes32[2] memory v4Ids = _v4RouteIds();
        bytes32[2] memory v3Ids = _v3RouteIds();
        UniswapV4ExactOutputAdapter.RouteConfig[] memory v4Routes = _v4Routes(v4Ids);
        PancakeV3ExactOutputAdapter.RouteConfig[] memory v3Routes = _v3Routes(v3Ids);

        _validateSafe(protocolSafe, expectedSafeOwner);
        _validateCore(basketFactory, assetRegistry, protocolSafe, assets, pins);
        _validateProbeLimits(probes);
        _validateUniswapV4(probes, pins);
        _validatePancakeV3(probes, pins);

        bytes32 configHash = keccak256(
            abi.encode(
                block.chainid,
                basketFactory,
                assetRegistry,
                protocolSafe,
                expectedSafeOwner,
                assets,
                probes,
                pins,
                USDC_IMPLEMENTATION,
                BSTOCK_BEACON,
                BSTOCK_IMPLEMENTATION,
                v4Ids,
                v3Ids,
                v4Routes,
                v3Routes,
                UNISWAP_UNIVERSAL_ROUTER_V2_1_1,
                UNISWAP_PERMIT2,
                UNISWAP_V4_QUOTER,
                PANCAKE_V3_ROUTER,
                PANCAKE_V3_QUOTER
            )
        );
        console2.log("Route configuration hash");
        console2.logBytes32(configHash);
        bytes32 confirmedConfigHash = vm.envOr("CONFIRM_ROUTE_CONFIG_HASH", bytes32(0));
        require(confirmedConfigHash != bytes32(0), "CONFIRM_ROUTE_CONFIG_HASH missing");
        require(confirmedConfigHash == configHash, "route configuration hash mismatch");

        vm.startBroadcast();

        v4Adapter = new UniswapV4ExactOutputAdapter(
            USDC, UNISWAP_UNIVERSAL_ROUTER_V2_1_1, UNISWAP_PERMIT2, UNISWAP_V4_QUOTER, v4Routes
        );
        v3Adapter = new PancakeV3ExactOutputAdapter(USDC, PANCAKE_V3_ROUTER, PANCAKE_V3_QUOTER, v3Routes);
        address[] memory adapters = new address[](2);
        adapters[0] = address(v4Adapter);
        adapters[1] = address(v3Adapter);
        buyRouter = new OneClickBasketRouter(USDC, basketFactory, adapters);

        vm.stopBroadcast();

        _validateDeployment(
            basketFactory, assetRegistry, v4Ids, v3Ids, v4Routes, v3Routes, v4Adapter, v3Adapter, buyRouter
        );

        console2.log("UniswapV4ExactOutputAdapter", address(v4Adapter));
        console2.log("PancakeV3ExactOutputAdapter", address(v3Adapter));
        console2.log("OneClickBasketRouter", address(buyRouter));
    }

    function _loadProbeLimits() internal view returns (ProbeLimits memory probes) {
        probes.rawOutput[0] = vm.envUint("PROBE_RAW_OUTPUT_NVDAB");
        probes.rawOutput[1] = vm.envUint("PROBE_RAW_OUTPUT_MSFTB");
        probes.rawOutput[2] = vm.envUint("PROBE_RAW_OUTPUT_TSLAB");
        probes.rawOutput[3] = vm.envUint("PROBE_RAW_OUTPUT_QQQB");
        probes.maxUsdcInput[0] = vm.envUint("MAX_PROBE_USDC_IN_NVDAB");
        probes.maxUsdcInput[1] = vm.envUint("MAX_PROBE_USDC_IN_MSFTB");
        probes.maxUsdcInput[2] = vm.envUint("MAX_PROBE_USDC_IN_TSLAB");
        probes.maxUsdcInput[3] = vm.envUint("MAX_PROBE_USDC_IN_QQQB");
    }

    function _loadCodehashPins() internal view returns (CodehashPins memory pins) {
        pins.usdc = vm.envBytes32("EXPECTED_USDC_CODEHASH");
        pins.usdt = vm.envBytes32("EXPECTED_USDT_CODEHASH");
        pins.usdcImplementation = vm.envBytes32("EXPECTED_USDC_IMPLEMENTATION_CODEHASH");
        pins.bstockBeacon = vm.envBytes32("EXPECTED_BSTOCK_BEACON_CODEHASH");
        pins.bstockImplementation = vm.envBytes32("EXPECTED_BSTOCK_IMPLEMENTATION_CODEHASH");
        pins.basketFactory = vm.envBytes32("EXPECTED_BASKET_FACTORY_CODEHASH");
        pins.assetRegistry = vm.envBytes32("EXPECTED_ASSET_REGISTRY_CODEHASH");
        pins.assets[0] = vm.envBytes32("EXPECTED_NVDAB_CODEHASH");
        pins.assets[1] = vm.envBytes32("EXPECTED_MSFTB_CODEHASH");
        pins.assets[2] = vm.envBytes32("EXPECTED_TSLAB_CODEHASH");
        pins.assets[3] = vm.envBytes32("EXPECTED_QQQB_CODEHASH");
        pins.pancakeV3Router = vm.envBytes32("EXPECTED_PANCAKE_V3_ROUTER_CODEHASH");
        pins.pancakeV3Factory = vm.envBytes32("EXPECTED_PANCAKE_V3_FACTORY_CODEHASH");
        pins.pancakeV3Quoter = vm.envBytes32("EXPECTED_PANCAKE_V3_QUOTER_CODEHASH");
        pins.pancakeV3MsftbPool = vm.envBytes32("EXPECTED_PANCAKE_V3_MSFTB_POOL_CODEHASH");
        pins.pancakeV3QqqbPool = vm.envBytes32("EXPECTED_PANCAKE_V3_QQQB_POOL_CODEHASH");
        pins.pancakeV3StablePool = vm.envBytes32("EXPECTED_PANCAKE_V3_STABLE_POOL_CODEHASH");
        pins.uniswapPoolManager = vm.envBytes32("EXPECTED_UNISWAP_V4_POOL_MANAGER_CODEHASH");
        pins.uniswapStateView = vm.envBytes32("EXPECTED_UNISWAP_V4_STATE_VIEW_CODEHASH");
        pins.uniswapV4Quoter = vm.envBytes32("EXPECTED_UNISWAP_V4_QUOTER_CODEHASH");
        pins.uniswapUniversalRouter = vm.envBytes32("EXPECTED_UNISWAP_UNIVERSAL_ROUTER_CODEHASH");
        pins.uniswapPermit2 = vm.envBytes32("EXPECTED_UNISWAP_PERMIT2_CODEHASH");
    }

    function _validateCore(
        address basketFactory,
        address assetRegistry,
        address protocolSafe,
        address[ASSET_COUNT] memory assets,
        CodehashPins memory pins
    ) internal view {
        _requireCodehash(USDC, pins.usdc, "USDC");
        _requireCodehash(USDT, pins.usdt, "USDT");
        _requireCodehash(USDC_IMPLEMENTATION, pins.usdcImplementation, "USDC implementation");
        require(
            _storageAddress(USDC, EIP1967_IMPLEMENTATION_SLOT) == USDC_IMPLEMENTATION, "USDC implementation mismatch"
        );
        _requireCodehash(BSTOCK_BEACON, pins.bstockBeacon, "bStock beacon");
        _requireCodehash(BSTOCK_IMPLEMENTATION, pins.bstockImplementation, "bStock implementation");
        require(
            IBeaconDeploymentProfile(BSTOCK_BEACON).implementation() == BSTOCK_IMPLEMENTATION,
            "bStock beacon implementation mismatch"
        );
        _requireCodehash(basketFactory, pins.basketFactory, "BasketFactory");
        _requireCodehash(assetRegistry, pins.assetRegistry, "CanonicalAssetRegistry");
        require(IBuyRouterFactoryProfile(basketFactory).assetRegistry() == assetRegistry, "factory registry mismatch");
        IBuyRouterAssetRegistryProfile registry = IBuyRouterAssetRegistryProfile(assetRegistry);
        require(registry.owner() == protocolSafe, "registry owner is not protocol Safe");
        require(registry.pendingOwner() == address(0), "unexpected pending registry owner");
        _validateStablecoin(USDC, "USDC");
        _validateStablecoin(USDT, "USDT");

        string[ASSET_COUNT] memory symbols = [string("NVDAB"), "MSFTB", "TSLAB", "QQQB"];
        for (uint256 i = 0; i < ASSET_COUNT; ++i) {
            _requireCodehash(assets[i], pins.assets[i], symbols[i]);
            require(_storageAddress(assets[i], EIP1967_BEACON_SLOT) == BSTOCK_BEACON, "bStock beacon mismatch");
            _validateBstock(assets[i], symbols[i]);
            require(registry.isSupported(assets[i]), "asset not supported");
        }
    }

    function _validateStablecoin(address token, string memory expectedSymbol) internal view {
        IERC20Metadata metadata = IERC20Metadata(token);
        require(metadata.decimals() == 18, "unexpected stablecoin decimals");
        require(keccak256(bytes(metadata.symbol())) == keccak256(bytes(expectedSymbol)), "unexpected stablecoin symbol");
    }

    function _validateBstock(address asset, string memory expectedSymbol) internal view {
        IERC20Metadata metadata = IERC20Metadata(asset);
        IERC8056DeploymentProfile scaled = IERC8056DeploymentProfile(asset);
        require(metadata.decimals() == 18, "unexpected bStock decimals");
        require(keccak256(bytes(metadata.symbol())) == keccak256(bytes(expectedSymbol)), "unexpected bStock symbol");
        require(scaled.supportsInterface(ERC8056_CORE_INTERFACE), "missing ERC-8056 core");
        require(scaled.supportsInterface(ERC8056_CONVERSION_INTERFACE), "missing ERC-8056 conversion");
        require(scaled.supportsInterface(ERC8056_PENDING_INTERFACE), "missing ERC-8056 pending state");
        require(scaled.uiMultiplier() > 0 && scaled.newUIMultiplier() > 0, "invalid ERC-8056 multiplier");
        uint256 displayed = scaled.toUIAmount(ERC8056_ROUNDTRIP_INPUT);
        require(displayed > 0, "zero ERC-8056 display amount");
        require(scaled.fromUIAmount(displayed) == ERC8056_ROUNDTRIP_INPUT, "inexact ERC-8056 roundtrip");
    }

    function _validateProbeLimits(ProbeLimits memory probes) internal pure {
        for (uint256 i = 0; i < ASSET_COUNT; ++i) {
            require(probes.rawOutput[i] >= MIN_PROBE_RAW_OUTPUT, "probe output below minimum");
            require(probes.maxUsdcInput[i] > 0, "probe input maximum missing");
        }
        require(probes.rawOutput[0] <= type(uint128).max, "NVDAB probe too large");
        require(probes.rawOutput[2] <= type(uint128).max, "TSLAB probe too large");
        require(probes.maxUsdcInput[0] <= type(uint128).max, "NVDAB maximum too large");
        require(probes.maxUsdcInput[2] <= type(uint128).max, "TSLAB maximum too large");
    }

    function _validateUniswapV4(ProbeLimits memory probes, CodehashPins memory pins) internal {
        _requireCodehash(UNISWAP_V4_POOL_MANAGER, pins.uniswapPoolManager, "Uniswap v4 PoolManager");
        _requireCodehash(UNISWAP_V4_STATE_VIEW, pins.uniswapStateView, "Uniswap v4 StateView");
        _requireCodehash(UNISWAP_V4_QUOTER, pins.uniswapV4Quoter, "Uniswap v4 Quoter");
        _requireCodehash(UNISWAP_UNIVERSAL_ROUTER_V2_1_1, pins.uniswapUniversalRouter, "Uniswap Universal Router 2.1.1");
        _requireCodehash(UNISWAP_PERMIT2, pins.uniswapPermit2, "Uniswap Permit2");
        require(
            IUniswapV4DeploymentStateView(UNISWAP_V4_STATE_VIEW).poolManager() == UNISWAP_V4_POOL_MANAGER,
            "StateView PoolManager mismatch"
        );
        require(
            IUniswapV4DeploymentQuoter(UNISWAP_V4_QUOTER).poolManager() == UNISWAP_V4_POOL_MANAGER,
            "V4 Quoter PoolManager mismatch"
        );

        _validateV4Pool(USDC, USDT, V4_STABLE_FEE, V4_STABLE_TICK_SPACING);
        _validateV4Pool(USDT, NVDAB, V4_NVDAB_FEE, V4_NVDAB_TICK_SPACING);
        _validateV4Pool(USDT, TSLAB, V4_TSLAB_FEE, V4_TSLAB_TICK_SPACING);
        _validateV4Quote(NVDAB, V4_NVDAB_FEE, V4_NVDAB_TICK_SPACING, probes.rawOutput[0], probes.maxUsdcInput[0]);
        _validateV4Quote(TSLAB, V4_TSLAB_FEE, V4_TSLAB_TICK_SPACING, probes.rawOutput[2], probes.maxUsdcInput[2]);
    }

    function _validateV4Pool(address tokenA, address tokenB, uint24 fee, int24 tickSpacing) internal view {
        bytes32 poolId = _v4PoolId(tokenA, tokenB, fee, tickSpacing);
        (uint160 sqrtPriceX96,,, uint24 liveLpFee) =
            IUniswapV4DeploymentStateView(UNISWAP_V4_STATE_VIEW).getSlot0(poolId);
        uint128 liquidity = IUniswapV4DeploymentStateView(UNISWAP_V4_STATE_VIEW).getLiquidity(poolId);
        require(sqrtPriceX96 > 0, "uninitialized V4 pool");
        require(liquidity > 0, "empty V4 pool");
        require(liveLpFee == fee, "unexpected V4 LP fee");
    }

    function _validateV4Quote(
        address output,
        uint24 stockFee,
        int24 stockTickSpacing,
        uint256 rawOutput,
        uint256 maxUsdcInput
    ) internal {
        require(rawOutput <= type(uint128).max, "V4 probe too large");
        IUniswapV4DeploymentQuoter.PathKey[] memory path = _v4QuoterPath(stockFee, stockTickSpacing);
        // Safe after the explicit bound above.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 exactAmount = uint128(rawOutput);
        IUniswapV4DeploymentQuoter.QuoteExactParams memory params =
            IUniswapV4DeploymentQuoter.QuoteExactParams({exactCurrency: output, path: path, exactAmount: exactAmount});
        (uint256 amountIn, uint256 gasEstimate) = IUniswapV4DeploymentQuoter(UNISWAP_V4_QUOTER).quoteExactOutput(params);
        require(amountIn > 0 && amountIn <= maxUsdcInput, "V4 probe exceeds maximum");
        require(gasEstimate > 0, "zero V4 quote gas");
        console2.log("V4 probe USDC input", amountIn);
    }

    function _validatePancakeV3(ProbeLimits memory probes, CodehashPins memory pins) internal {
        _requireCodehash(PANCAKE_V3_ROUTER, pins.pancakeV3Router, "Pancake v3 SmartRouter");
        _requireCodehash(PANCAKE_V3_FACTORY, pins.pancakeV3Factory, "Pancake v3 factory");
        _requireCodehash(PANCAKE_V3_QUOTER, pins.pancakeV3Quoter, "Pancake v3 QuoterV2");
        _requireCodehash(PANCAKE_V3_MSFTB_USDT_POOL, pins.pancakeV3MsftbPool, "MSFTB/USDT v3 pool");
        _requireCodehash(PANCAKE_V3_QQQB_USDT_POOL, pins.pancakeV3QqqbPool, "QQQB/USDT v3 pool");
        _requireCodehash(PANCAKE_V3_USDT_USDC_POOL, pins.pancakeV3StablePool, "USDT/USDC v3 pool");

        IPancakeV3DeploymentRouter router = IPancakeV3DeploymentRouter(PANCAKE_V3_ROUTER);
        require(router.factoryV2() == PANCAKE_V2_FACTORY, "SmartRouter V2 factory mismatch");
        require(router.factory() == PANCAKE_V3_FACTORY, "SmartRouter V3 factory mismatch");
        require(
            IPancakeV3DeploymentQuoter(PANCAKE_V3_QUOTER).factory() == PANCAKE_V3_FACTORY, "QuoterV2 factory mismatch"
        );

        _validateV3Pool(MSFTB, USDT, V3_MSFTB_FEE, PANCAKE_V3_MSFTB_USDT_POOL);
        _validateV3Pool(QQQB, USDT, V3_QQQB_FEE, PANCAKE_V3_QQQB_USDT_POOL);
        _validateV3Pool(USDT, USDC, V3_STABLE_FEE, PANCAKE_V3_USDT_USDC_POOL);
        _validateV3Quote(_msftbV3Path(), probes.rawOutput[1], probes.maxUsdcInput[1]);
        _validateV3Quote(_qqqbV3Path(), probes.rawOutput[3], probes.maxUsdcInput[3]);
    }

    function _validateV3Pool(address tokenA, address tokenB, uint24 fee, address expectedPool) internal view {
        address pool = IPancakeV3DeploymentFactory(PANCAKE_V3_FACTORY).getPool(tokenA, tokenB, fee);
        require(pool == expectedPool, "unexpected Pancake v3 pool");
        require(IPancakeV3DeploymentPool(pool).liquidity() > 0, "empty Pancake v3 pool");
    }

    function _validateV3Quote(bytes memory path, uint256 rawOutput, uint256 maxUsdcInput) internal {
        _validateV3Path(path);
        (
            uint256 amountIn,
            uint160[] memory sqrtPriceAfter,
            uint32[] memory initializedTicksCrossed,
            uint256 gasEstimate
        ) = IPancakeV3DeploymentQuoter(PANCAKE_V3_QUOTER).quoteExactOutput(path, rawOutput);
        require(amountIn > 0 && amountIn <= maxUsdcInput, "V3 probe exceeds maximum");
        require(sqrtPriceAfter.length == V3_HOPS && initializedTicksCrossed.length == V3_HOPS, "invalid V3 quote");
        require(gasEstimate > 0, "zero V3 quote gas");
        console2.log("V3 probe USDC input", amountIn);
    }

    function _validateV3Path(bytes memory path) internal view {
        require(path.length == V3_ADDRESS_SIZE + V3_HOPS * V3_NEXT_OFFSET, "invalid V3 path length");
        require(_addressAt(path, path.length - V3_ADDRESS_SIZE) == USDC, "invalid V3 input");
        for (uint256 i = 0; i <= V3_HOPS; ++i) {
            address token = _addressAt(path, i * V3_NEXT_OFFSET);
            require(token != address(0) && token.code.length > 0, "invalid V3 path token");
            if (i < V3_HOPS) require(_uint24At(path, i * V3_NEXT_OFFSET + V3_ADDRESS_SIZE) > 0, "zero V3 fee");
        }
    }

    function _validateDeployment(
        address basketFactory,
        address assetRegistry,
        bytes32[2] memory v4Ids,
        bytes32[2] memory v3Ids,
        UniswapV4ExactOutputAdapter.RouteConfig[] memory v4Routes,
        PancakeV3ExactOutputAdapter.RouteConfig[] memory v3Routes,
        UniswapV4ExactOutputAdapter v4Adapter,
        PancakeV3ExactOutputAdapter v3Adapter,
        OneClickBasketRouter buyRouter
    ) internal view {
        require(v4Adapter.inputToken() == USDC, "V4 adapter input mismatch");
        require(v4Adapter.universalRouter() == UNISWAP_UNIVERSAL_ROUTER_V2_1_1, "V4 router mismatch");
        require(v4Adapter.permit2() == UNISWAP_PERMIT2, "V4 Permit2 mismatch");
        require(v4Adapter.quoter() == UNISWAP_V4_QUOTER, "V4 quoter mismatch");
        require(v3Adapter.inputToken() == USDC, "V3 adapter input mismatch");
        require(v3Adapter.dexRouter() == PANCAKE_V3_ROUTER, "V3 router mismatch");
        require(v3Adapter.quoter() == PANCAKE_V3_QUOTER, "V3 quoter mismatch");

        for (uint256 i = 0; i < v4Routes.length; ++i) {
            require(v4Adapter.routeOutput(v4Ids[i]) == v4Routes[i].output, "V4 route output mismatch");
            require(
                v4Adapter.routeHash(v4Ids[i]) == keccak256(abi.encode(v4Routes[i].output, v4Routes[i].path)),
                "V4 route hash mismatch"
            );
        }
        for (uint256 i = 0; i < v3Routes.length; ++i) {
            require(v3Adapter.routeOutput(v3Ids[i]) == _v3OutputAt(i), "V3 route output mismatch");
            require(v3Adapter.routeHash(v3Ids[i]) == keccak256(v3Routes[i].path), "V3 route hash mismatch");
        }

        require(buyRouter.usdc() == USDC, "buy router USDC mismatch");
        require(buyRouter.basketFactory() == basketFactory, "buy router factory mismatch");
        require(buyRouter.assetRegistry() == assetRegistry, "buy router registry mismatch");
        address[] memory adapters = buyRouter.adapters();
        require(adapters.length == 2, "buy router adapter count mismatch");
        require(adapters[0] == address(v4Adapter) && adapters[1] == address(v3Adapter), "adapter order mismatch");
        require(buyRouter.adapterCodehash(address(v4Adapter)) == address(v4Adapter).codehash, "V4 codehash mismatch");
        require(buyRouter.adapterCodehash(address(v3Adapter)) == address(v3Adapter).codehash, "V3 codehash mismatch");
    }

    function _v4Routes(bytes32[2] memory ids)
        internal
        pure
        returns (UniswapV4ExactOutputAdapter.RouteConfig[] memory routes)
    {
        routes = new UniswapV4ExactOutputAdapter.RouteConfig[](2);
        routes[0] = UniswapV4ExactOutputAdapter.RouteConfig({
            id: ids[0], output: NVDAB, path: _v4AdapterPath(V4_NVDAB_FEE, V4_NVDAB_TICK_SPACING)
        });
        routes[1] = UniswapV4ExactOutputAdapter.RouteConfig({
            id: ids[1], output: TSLAB, path: _v4AdapterPath(V4_TSLAB_FEE, V4_TSLAB_TICK_SPACING)
        });
    }

    function _v3Routes(bytes32[2] memory ids)
        internal
        pure
        returns (PancakeV3ExactOutputAdapter.RouteConfig[] memory routes)
    {
        routes = new PancakeV3ExactOutputAdapter.RouteConfig[](2);
        routes[0] = PancakeV3ExactOutputAdapter.RouteConfig({id: ids[0], path: _msftbV3Path()});
        routes[1] = PancakeV3ExactOutputAdapter.RouteConfig({id: ids[1], path: _qqqbV3Path()});
    }

    function _v4AdapterPath(uint24 stockFee, int24 stockTickSpacing)
        internal
        pure
        returns (UniswapV4ExactOutputAdapter.HopConfig[] memory path)
    {
        path = new UniswapV4ExactOutputAdapter.HopConfig[](2);
        path[0] = UniswapV4ExactOutputAdapter.HopConfig({
            intermediateCurrency: USDC, fee: V4_STABLE_FEE, tickSpacing: V4_STABLE_TICK_SPACING
        });
        path[1] = UniswapV4ExactOutputAdapter.HopConfig({
            intermediateCurrency: USDT, fee: stockFee, tickSpacing: stockTickSpacing
        });
    }

    function _v4QuoterPath(uint24 stockFee, int24 stockTickSpacing)
        internal
        pure
        returns (IUniswapV4DeploymentQuoter.PathKey[] memory path)
    {
        path = new IUniswapV4DeploymentQuoter.PathKey[](2);
        path[0] = IUniswapV4DeploymentQuoter.PathKey({
            intermediateCurrency: USDC,
            fee: V4_STABLE_FEE,
            tickSpacing: V4_STABLE_TICK_SPACING,
            hooks: address(0),
            hookData: bytes("")
        });
        path[1] = IUniswapV4DeploymentQuoter.PathKey({
            intermediateCurrency: USDT,
            fee: stockFee,
            tickSpacing: stockTickSpacing,
            hooks: address(0),
            hookData: bytes("")
        });
    }

    function _msftbV3Path() internal pure returns (bytes memory) {
        return abi.encodePacked(MSFTB, V3_MSFTB_FEE, USDT, V3_STABLE_FEE, USDC);
    }

    function _qqqbV3Path() internal pure returns (bytes memory) {
        return abi.encodePacked(QQQB, V3_QQQB_FEE, USDT, V3_STABLE_FEE, USDC);
    }

    function _v4PoolId(address tokenA, address tokenB, uint24 fee, int24 tickSpacing) internal pure returns (bytes32) {
        (address currency0, address currency1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(
            abi.encode(
                V4PoolKey({
                    currency0: currency0, currency1: currency1, fee: fee, tickSpacing: tickSpacing, hooks: address(0)
                })
            )
        );
    }

    function _requireCodehash(address target, bytes32 expected, string memory label) internal view {
        require(target != address(0) && target.code.length > 0, string.concat(label, " has no code"));
        require(expected != bytes32(0), string.concat(label, " expected codehash missing"));
        require(target.codehash == expected, string.concat(label, " codehash mismatch"));
    }

    function _storageAddress(address target, bytes32 slot) internal view returns (address) {
        uint256 rawValue = uint256(vm.load(target, slot));
        require(rawValue <= type(uint160).max, "malformed address storage slot");
        // Safe after the explicit bound above.
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(rawValue));
    }

    function _assets() internal pure returns (address[ASSET_COUNT] memory assets) {
        assets[0] = NVDAB;
        assets[1] = MSFTB;
        assets[2] = TSLAB;
        assets[3] = QQQB;
    }

    function _v3OutputAt(uint256 index) internal pure returns (address) {
        return index == 0 ? MSFTB : QQQB;
    }

    function _v4RouteIds() internal pure returns (bytes32[2] memory ids) {
        ids[0] = keccak256("WOVEN:UNISWAP_V4:USDC:USDT:NVDAB:1");
        ids[1] = keccak256("WOVEN:UNISWAP_V4:USDC:USDT:TSLAB:1");
    }

    function _v3RouteIds() internal pure returns (bytes32[2] memory ids) {
        ids[0] = keccak256("WOVEN:PANCAKE_V3:USDC:USDT:MSFTB:1");
        ids[1] = keccak256("WOVEN:PANCAKE_V3:USDC:USDT:QQQB:1");
    }

    function _addressAt(bytes memory data, uint256 offset) internal pure returns (address result) {
        assembly ("memory-safe") {
            result := shr(96, mload(add(add(data, 0x20), offset)))
        }
    }

    function _uint24At(bytes memory data, uint256 offset) internal pure returns (uint24 result) {
        assembly ("memory-safe") {
            result := shr(232, mload(add(add(data, 0x20), offset)))
        }
    }
}
