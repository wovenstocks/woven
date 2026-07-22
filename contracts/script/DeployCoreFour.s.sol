// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {DeploymentSafeProfile} from "./DeploymentSafeProfile.sol";

interface ICoreFourFactory {
    function creatorLicense() external view returns (address);
    function assetRegistry() external view returns (address);
    function splitter() external view returns (address);
    function basketGuardian() external view returns (address);
    function STARTER_CAP() external view returns (uint256);
    function CEILING() external view returns (uint256);
    function basketCount() external view returns (uint256);
    function creatorOf(address basket) external view returns (address);
    function createBasket(
        string calldata name,
        string calldata symbol,
        address[] calldata tokens,
        uint256[] calldata unitsPerBasket,
        uint16 mintFeeBps,
        uint256 initialSupplyCap
    ) external returns (address basket);
}

interface ICoreFourRegistry {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function isSupported(address asset) external view returns (bool);
}

interface ICoreFourLicense {
    function wovenToken() external view returns (address);
    function LICENSE_BURN_AMOUNT() external view returns (uint256);
    function isLicensed(address creator) external view returns (bool);
}

interface ICoreFourWoven {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function _mode() external view returns (uint256);
    function owner() external view returns (address);
}

interface ICoreFourScaledAsset {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function toUIAmount(uint256 rawAmount) external view returns (uint256);
    function fromUIAmount(uint256 uiAmount) external view returns (uint256);
}

interface ICoreFourBeacon {
    function implementation() external view returns (address);
}

interface ICoreFourRouter {
    function usdc() external view returns (address);
    function basketFactory() external view returns (address);
    function assetRegistry() external view returns (address);
    function adapterCodehash(address adapter) external view returns (bytes32);
    function adapters() external view returns (address[] memory);
}

interface ICoreFourAdapter {
    function inputToken() external view returns (address);
    function routeOutput(bytes32 routeId) external view returns (address);
}

interface ICoreFourSplitter {
    function creatorOf(address basket) external view returns (address);
}

interface ICoreFourBasket {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function constituents() external view returns (address[] memory);
    function units() external view returns (uint256[] memory);
    function mintFeeBps() external view returns (uint16);
    function supplyCap() external view returns (uint256);
    function maxSupplyCap() external view returns (uint256);
    function guardian() external view returns (address);
    function feeRecipient() external view returns (address);
    function getRequiredUnits(uint256 basketAmount)
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts);
}

/// @notice Fail-closed deployment for the first basket fully covered by the
///         initial four-asset USDC router: NVDAB, MSFTB, TSLAB, and QQQB.
/// @dev Registry admission through the protocol Safe and the creator-license
///      burn are explicit prerequisites. This script cannot execute either on
///      the creator's behalf and never treats TECH5 as router-compatible.
contract DeployCoreFour is Script, DeploymentSafeProfile {
    uint256 internal constant BNB_MAINNET_CHAIN_ID = 56;
    uint256 internal constant ASSET_COUNT = 4;

    string internal constant BASKET_NAME = "Woven Core Four";
    string internal constant BASKET_SYMBOL = "CORE4";
    uint16 internal constant MINT_FEE_BPS = 30;
    uint256 internal constant INITIAL_SUPPLY_CAP = 1_000e18;
    uint256 internal constant MAX_SUPPLY_CAP = 1_000_000e18;
    uint256 internal constant LICENSE_BURN_AMOUNT = 10_000e18;
    uint256 internal constant WOVEN_TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 internal constant DISPLAYED_UNIT_PER_ASSET = 1e16;

    bytes32 internal constant EIP1967_IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 internal constant EIP1967_BEACON_SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;

    address internal constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address internal constant USDC_IMPLEMENTATION = 0xBA5Fe23f8a3a24BEd3236F05F2FcF35fd0BF0B5C;
    address internal constant BSTOCK_BEACON = 0x156D6dce9a4f6139a3406F1f021F1A4880De93a3;
    address internal constant BSTOCK_IMPLEMENTATION = 0xCFEd6c4679297ea4889F8183bC057B4A86C64e46;
    address internal constant NVDAB = 0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436;
    address internal constant MSFTB = 0x80106cb3EAD06659A5ad19DF39D9b4733863B9b0;
    address internal constant TSLAB = 0x5b1910eAaD6450E50f816082Aa078C41F10C292f;
    address internal constant QQQB = 0x205812CdBed920aFf76C6580abD681a46D11efc7;

    bytes32 internal constant NVDAB_ROUTE_ID = keccak256("WOVEN:UNISWAP_V4:USDC:USDT:NVDAB:1");
    bytes32 internal constant TSLAB_ROUTE_ID = keccak256("WOVEN:UNISWAP_V4:USDC:USDT:TSLAB:1");
    bytes32 internal constant MSFTB_ROUTE_ID = keccak256("WOVEN:PANCAKE_V3:USDC:USDT:MSFTB:1");
    bytes32 internal constant QQQB_ROUTE_ID = keccak256("WOVEN:PANCAKE_V3:USDC:USDT:QQQB:1");

    struct Addresses {
        address protocolSafe;
        address expectedSafeOwner;
        address woven;
        address creatorLicense;
        address assetRegistry;
        address feeSplitter;
        address curatorGuardian;
        address basketFactory;
        address buyRouter;
        address uniswapV4Adapter;
        address pancakeV3Adapter;
        address creator;
    }

    struct CodehashPins {
        bytes32 protocolSafe;
        bytes32 woven;
        bytes32 creatorLicense;
        bytes32 assetRegistry;
        bytes32 feeSplitter;
        bytes32 curatorGuardian;
        bytes32 basketFactory;
        bytes32 buyRouter;
        bytes32 uniswapV4Adapter;
        bytes32 pancakeV3Adapter;
        bytes32 usdc;
        bytes32 usdcImplementation;
        bytes32 bstockBeacon;
        bytes32 bstockImplementation;
        bytes32[ASSET_COUNT] assets;
    }

    function run() external returns (address basket) {
        require(vm.envBool("CONFIRM_DEPLOY"), "CONFIRM_DEPLOY must be true");
        require(vm.envBool("CONFIRM_CORE_FOUR_LAUNCH"), "CORE4 launch not confirmed");
        require(vm.envUint("EXPECTED_CHAIN_ID") == BNB_MAINNET_CHAIN_ID, "expected chain must be BNB mainnet");
        require(block.chainid == BNB_MAINNET_CHAIN_ID, "unexpected chain id");

        Addresses memory addresses_ = _loadAddresses();
        CodehashPins memory pins = _loadCodehashPins();
        address[ASSET_COUNT] memory assets = _assets();
        _validateCode(addresses_, pins, assets);
        _validateSafe(addresses_.protocolSafe, addresses_.expectedSafeOwner);
        uint256[ASSET_COUNT] memory units = _deriveRawUnits(assets);
        uint256 expectedBasketCount = vm.envUint("EXPECTED_CORE_FOUR_FACTORY_BASKET_COUNT");

        _validatePrerequisites(addresses_, assets, units, expectedBasketCount);

        bytes32 configHash = keccak256(
            abi.encode(
                block.chainid,
                BASKET_NAME,
                BASKET_SYMBOL,
                MINT_FEE_BPS,
                INITIAL_SUPPLY_CAP,
                expectedBasketCount,
                addresses_,
                pins,
                assets,
                units,
                NVDAB_ROUTE_ID,
                MSFTB_ROUTE_ID,
                TSLAB_ROUTE_ID,
                QQQB_ROUTE_ID,
                USDC_IMPLEMENTATION,
                BSTOCK_BEACON,
                BSTOCK_IMPLEMENTATION
            )
        );
        console2.log("CORE4 configuration hash");
        console2.logBytes32(configHash);
        bytes32 confirmedConfigHash = vm.envOr("CONFIRM_CORE_FOUR_CONFIG_HASH", bytes32(0));
        require(confirmedConfigHash != bytes32(0), "CONFIRM_CORE_FOUR_CONFIG_HASH missing");
        require(confirmedConfigHash == configHash, "CORE4 configuration hash mismatch");

        vm.startBroadcast(addresses_.creator);
        basket = ICoreFourFactory(addresses_.basketFactory)
            .createBasket(
                BASKET_NAME,
                BASKET_SYMBOL,
                _dynamicAddresses(assets),
                _dynamicUnits(units),
                MINT_FEE_BPS,
                INITIAL_SUPPLY_CAP
            );
        vm.stopBroadcast();

        _validateDeployment(addresses_, assets, units, expectedBasketCount, basket);
        console2.log("Woven Core Four", basket);
        console2.log("VITE_BASKET_CORE4_UNITS_RAW order: NVDAB,MSFTB,TSLAB,QQQB");
    }

    function _loadAddresses() internal view returns (Addresses memory addresses_) {
        addresses_.protocolSafe = vm.envAddress("PROTOCOL_SAFE");
        addresses_.expectedSafeOwner = vm.envAddress("EXPECTED_SAFE_OWNER");
        addresses_.woven = vm.envAddress("WOVEN_TOKEN");
        addresses_.creatorLicense = vm.envAddress("CREATOR_LICENSE");
        addresses_.assetRegistry = vm.envAddress("ASSET_REGISTRY");
        addresses_.feeSplitter = vm.envAddress("FEE_SPLITTER");
        addresses_.curatorGuardian = vm.envAddress("CURATOR_GUARDIAN");
        addresses_.basketFactory = vm.envAddress("BASKET_FACTORY");
        addresses_.buyRouter = vm.envAddress("ONE_CLICK_ROUTER");
        addresses_.uniswapV4Adapter = vm.envAddress("UNISWAP_V4_ADAPTER");
        addresses_.pancakeV3Adapter = vm.envAddress("PANCAKE_V3_ADAPTER");
        addresses_.creator = vm.envAddress("EXPECTED_CREATOR");
    }

    function _loadCodehashPins() internal view returns (CodehashPins memory pins) {
        pins.protocolSafe = vm.envBytes32("EXPECTED_PROTOCOL_SAFE_CODEHASH");
        pins.woven = vm.envBytes32("EXPECTED_WOVEN_CODEHASH");
        pins.creatorLicense = vm.envBytes32("EXPECTED_CREATOR_LICENSE_CODEHASH");
        pins.assetRegistry = vm.envBytes32("EXPECTED_ASSET_REGISTRY_CODEHASH");
        pins.feeSplitter = vm.envBytes32("EXPECTED_FEE_SPLITTER_CODEHASH");
        pins.curatorGuardian = vm.envBytes32("EXPECTED_CURATOR_GUARDIAN_CODEHASH");
        pins.basketFactory = vm.envBytes32("EXPECTED_BASKET_FACTORY_CODEHASH");
        pins.buyRouter = vm.envBytes32("EXPECTED_ONE_CLICK_ROUTER_CODEHASH");
        pins.uniswapV4Adapter = vm.envBytes32("EXPECTED_UNISWAP_V4_ADAPTER_CODEHASH");
        pins.pancakeV3Adapter = vm.envBytes32("EXPECTED_PANCAKE_V3_ADAPTER_CODEHASH");
        pins.usdc = vm.envBytes32("EXPECTED_USDC_CODEHASH");
        pins.usdcImplementation = vm.envBytes32("EXPECTED_USDC_IMPLEMENTATION_CODEHASH");
        pins.bstockBeacon = vm.envBytes32("EXPECTED_BSTOCK_BEACON_CODEHASH");
        pins.bstockImplementation = vm.envBytes32("EXPECTED_BSTOCK_IMPLEMENTATION_CODEHASH");
        pins.assets[0] = vm.envBytes32("EXPECTED_NVDAB_CODEHASH");
        pins.assets[1] = vm.envBytes32("EXPECTED_MSFTB_CODEHASH");
        pins.assets[2] = vm.envBytes32("EXPECTED_TSLAB_CODEHASH");
        pins.assets[3] = vm.envBytes32("EXPECTED_QQQB_CODEHASH");
    }

    function _deriveRawUnits(address[ASSET_COUNT] memory assets)
        internal
        view
        returns (uint256[ASSET_COUNT] memory units)
    {
        for (uint256 i = 0; i < ASSET_COUNT; ++i) {
            ICoreFourScaledAsset asset = ICoreFourScaledAsset(assets[i]);
            units[i] = asset.fromUIAmount(DISPLAYED_UNIT_PER_ASSET);
            require(units[i] > 0, "zero CORE4 raw unit");
            require(asset.toUIAmount(units[i]) == DISPLAYED_UNIT_PER_ASSET, "inexact CORE4 displayed unit");
        }
    }

    function _validatePrerequisites(
        Addresses memory addresses_,
        address[ASSET_COUNT] memory assets,
        uint256[ASSET_COUNT] memory units,
        uint256 expectedBasketCount
    ) internal view {
        require(addresses_.creator != address(0), "creator is zero");

        ICoreFourWoven woven = ICoreFourWoven(addresses_.woven);
        require(keccak256(bytes(woven.name())) == keccak256(bytes("Woven Stocks")), "unexpected WOVEN name");
        require(keccak256(bytes(woven.symbol())) == keccak256(bytes("WOVEN")), "unexpected WOVEN symbol");
        require(woven.decimals() == 18, "unexpected WOVEN decimals");
        require(woven.totalSupply() == WOVEN_TOTAL_SUPPLY, "unexpected WOVEN supply");
        require(woven._mode() == 0, "WOVEN has not graduated");
        require(woven.owner() == address(0), "WOVEN ownership not renounced");

        ICoreFourFactory factory = ICoreFourFactory(addresses_.basketFactory);
        require(factory.creatorLicense() == addresses_.creatorLicense, "factory license mismatch");
        require(factory.assetRegistry() == addresses_.assetRegistry, "factory registry mismatch");
        require(factory.splitter() == addresses_.feeSplitter, "factory splitter mismatch");
        require(factory.basketGuardian() == addresses_.curatorGuardian, "factory guardian mismatch");
        require(factory.STARTER_CAP() == INITIAL_SUPPLY_CAP, "unexpected starter cap");
        require(factory.CEILING() == MAX_SUPPLY_CAP, "unexpected maximum cap");
        require(factory.basketCount() == expectedBasketCount, "factory basket count changed");

        ICoreFourRegistry registry = ICoreFourRegistry(addresses_.assetRegistry);
        _validateRegistryOwnership(registry, addresses_.protocolSafe);
        ICoreFourLicense license = ICoreFourLicense(addresses_.creatorLicense);
        require(license.wovenToken() == addresses_.woven, "license WOVEN mismatch");
        require(license.LICENSE_BURN_AMOUNT() == LICENSE_BURN_AMOUNT, "license burn amount mismatch");
        require(license.isLicensed(addresses_.creator), "creator license missing");

        string[ASSET_COUNT] memory symbols = [string("NVDAB"), "MSFTB", "TSLAB", "QQQB"];
        for (uint256 i = 0; i < ASSET_COUNT; ++i) {
            require(registry.isSupported(assets[i]), "CORE4 asset not admitted by Safe");
            require(_storageAddress(assets[i], EIP1967_BEACON_SLOT) == BSTOCK_BEACON, "bStock beacon mismatch");
            ICoreFourScaledAsset asset = ICoreFourScaledAsset(assets[i]);
            require(asset.decimals() == 18, "unexpected bStock decimals");
            require(keccak256(bytes(asset.symbol())) == keccak256(bytes(symbols[i])), "unexpected bStock symbol");
            uint256 displayedUnits = asset.toUIAmount(units[i]);
            require(displayedUnits == DISPLAYED_UNIT_PER_ASSET, "unexpected displayed CORE4 unit");
            require(asset.fromUIAmount(displayedUnits) == units[i], "inexact CORE4 scaled-unit roundtrip");
        }

        ICoreFourRouter buyRouter = ICoreFourRouter(addresses_.buyRouter);
        require(buyRouter.usdc() == USDC, "buy router USDC mismatch");
        require(buyRouter.basketFactory() == addresses_.basketFactory, "buy router factory mismatch");
        require(buyRouter.assetRegistry() == addresses_.assetRegistry, "buy router registry mismatch");
        address[] memory adapters = buyRouter.adapters();
        require(adapters.length == 2, "unexpected adapter count");
        require(
            adapters[0] == addresses_.uniswapV4Adapter && adapters[1] == addresses_.pancakeV3Adapter,
            "unexpected adapter order"
        );
        require(
            buyRouter.adapterCodehash(addresses_.uniswapV4Adapter) == addresses_.uniswapV4Adapter.codehash,
            "stale Uniswap adapter"
        );
        require(
            buyRouter.adapterCodehash(addresses_.pancakeV3Adapter) == addresses_.pancakeV3Adapter.codehash,
            "stale Pancake adapter"
        );
        require(ICoreFourAdapter(addresses_.uniswapV4Adapter).inputToken() == USDC, "Uniswap adapter input mismatch");
        require(ICoreFourAdapter(addresses_.pancakeV3Adapter).inputToken() == USDC, "Pancake adapter input mismatch");
        require(
            ICoreFourAdapter(addresses_.uniswapV4Adapter).routeOutput(NVDAB_ROUTE_ID) == NVDAB, "NVDAB route missing"
        );
        require(
            ICoreFourAdapter(addresses_.pancakeV3Adapter).routeOutput(MSFTB_ROUTE_ID) == MSFTB, "MSFTB route missing"
        );
        require(
            ICoreFourAdapter(addresses_.uniswapV4Adapter).routeOutput(TSLAB_ROUTE_ID) == TSLAB, "TSLAB route missing"
        );
        require(ICoreFourAdapter(addresses_.pancakeV3Adapter).routeOutput(QQQB_ROUTE_ID) == QQQB, "QQQB route missing");
    }

    function _validateRegistryOwnership(ICoreFourRegistry registry, address protocolSafe) internal view {
        require(registry.owner() == protocolSafe, "registry owner is not protocol Safe");
        require(registry.pendingOwner() == address(0), "unexpected pending registry owner");
    }

    function _validateCode(Addresses memory addresses_, CodehashPins memory pins, address[ASSET_COUNT] memory assets)
        internal
        view
    {
        _requireCodehash(addresses_.protocolSafe, pins.protocolSafe, "protocol Safe");
        _requireCodehash(addresses_.woven, pins.woven, "WOVEN");
        _requireCodehash(addresses_.creatorLicense, pins.creatorLicense, "CreatorLicense");
        _requireCodehash(addresses_.assetRegistry, pins.assetRegistry, "CanonicalAssetRegistry");
        _requireCodehash(addresses_.feeSplitter, pins.feeSplitter, "FeeSplitter");
        _requireCodehash(addresses_.curatorGuardian, pins.curatorGuardian, "CuratorGuardian");
        _requireCodehash(addresses_.basketFactory, pins.basketFactory, "BasketFactory");
        _requireCodehash(addresses_.buyRouter, pins.buyRouter, "OneClickBasketRouter");
        _requireCodehash(addresses_.uniswapV4Adapter, pins.uniswapV4Adapter, "Uniswap v4 adapter");
        _requireCodehash(addresses_.pancakeV3Adapter, pins.pancakeV3Adapter, "Pancake v3 adapter");
        _requireCodehash(USDC, pins.usdc, "USDC");
        _requireCodehash(USDC_IMPLEMENTATION, pins.usdcImplementation, "USDC implementation");
        require(
            _storageAddress(USDC, EIP1967_IMPLEMENTATION_SLOT) == USDC_IMPLEMENTATION, "USDC implementation mismatch"
        );
        _requireCodehash(BSTOCK_BEACON, pins.bstockBeacon, "bStock beacon");
        _requireCodehash(BSTOCK_IMPLEMENTATION, pins.bstockImplementation, "bStock implementation");
        require(
            ICoreFourBeacon(BSTOCK_BEACON).implementation() == BSTOCK_IMPLEMENTATION, "bStock implementation mismatch"
        );

        string[ASSET_COUNT] memory symbols = [string("NVDAB"), "MSFTB", "TSLAB", "QQQB"];
        for (uint256 i = 0; i < ASSET_COUNT; ++i) {
            _requireCodehash(assets[i], pins.assets[i], symbols[i]);
        }
    }

    function _validateDeployment(
        Addresses memory addresses_,
        address[ASSET_COUNT] memory assets,
        uint256[ASSET_COUNT] memory units,
        uint256 expectedBasketCount,
        address basket
    ) internal view {
        require(basket != address(0) && basket.code.length > 0, "CORE4 has no code");
        ICoreFourFactory factory = ICoreFourFactory(addresses_.basketFactory);
        require(factory.basketCount() == expectedBasketCount + 1, "factory count did not increment");
        require(factory.creatorOf(basket) == addresses_.creator, "CORE4 creator mismatch");
        require(ICoreFourSplitter(addresses_.feeSplitter).creatorOf(basket) == addresses_.creator, "splitter mismatch");

        ICoreFourBasket deployed = ICoreFourBasket(basket);
        require(keccak256(bytes(deployed.name())) == keccak256(bytes(BASKET_NAME)), "CORE4 name mismatch");
        require(keccak256(bytes(deployed.symbol())) == keccak256(bytes(BASKET_SYMBOL)), "CORE4 symbol mismatch");
        require(deployed.decimals() == 18, "CORE4 decimals mismatch");
        require(deployed.mintFeeBps() == MINT_FEE_BPS, "CORE4 fee mismatch");
        require(deployed.supplyCap() == INITIAL_SUPPLY_CAP, "CORE4 cap mismatch");
        require(deployed.maxSupplyCap() == MAX_SUPPLY_CAP, "CORE4 maximum cap mismatch");
        require(deployed.guardian() == addresses_.curatorGuardian, "CORE4 guardian mismatch");
        require(deployed.feeRecipient() == addresses_.feeSplitter, "CORE4 fee recipient mismatch");
        _requireAddressArray(deployed.constituents(), assets, "CORE4 constituent mismatch");
        _requireUintArray(deployed.units(), units, "CORE4 unit mismatch");
        (address[] memory requiredTokens, uint256[] memory requiredUnits) = deployed.getRequiredUnits(1e18);
        _requireAddressArray(requiredTokens, assets, "CORE4 required token mismatch");
        _requireUintArray(requiredUnits, units, "CORE4 required unit mismatch");
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

    function _requireAddressArray(address[] memory actual, address[ASSET_COUNT] memory expected, string memory message)
        internal
        pure
    {
        require(actual.length == ASSET_COUNT, message);
        for (uint256 i = 0; i < ASSET_COUNT; ++i) {
            require(actual[i] == expected[i], message);
        }
    }

    function _requireUintArray(uint256[] memory actual, uint256[ASSET_COUNT] memory expected, string memory message)
        internal
        pure
    {
        require(actual.length == ASSET_COUNT, message);
        for (uint256 i = 0; i < ASSET_COUNT; ++i) {
            require(actual[i] == expected[i], message);
        }
    }

    function _assets() internal pure returns (address[ASSET_COUNT] memory assets) {
        assets[0] = NVDAB;
        assets[1] = MSFTB;
        assets[2] = TSLAB;
        assets[3] = QQQB;
    }

    function _dynamicAddresses(address[ASSET_COUNT] memory fixedValues)
        internal
        pure
        returns (address[] memory values)
    {
        values = new address[](ASSET_COUNT);
        for (uint256 i = 0; i < ASSET_COUNT; ++i) {
            values[i] = fixedValues[i];
        }
    }

    function _dynamicUnits(uint256[ASSET_COUNT] memory fixedValues) internal pure returns (uint256[] memory values) {
        values = new uint256[](ASSET_COUNT);
        for (uint256 i = 0; i < ASSET_COUNT; ++i) {
            values[i] = fixedValues[i];
        }
    }
}
