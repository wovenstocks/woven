// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {BasketFactory, ICreatorLicense, ICanonicalAssetRegistry} from "../src/BasketFactory.sol";
import {CanonicalAssetRegistry} from "../src/CanonicalAssetRegistry.sol";
import {CreatorLicense} from "../src/CreatorLicense.sol";
import {CuratorGuardian} from "../src/CuratorGuardian.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";
import {DeploymentSafeProfile} from "./DeploymentSafeProfile.sol";

interface IFourMemeLaunchToken is IERC20Metadata {
    function _mode() external view returns (uint256);
    function owner() external view returns (address);
}

/// @notice Fail-closed deployment wiring for BNB Smart Chain.
/// @dev No assets are whitelisted here. The protocol Safe must separately add
///      canonical bStock addresses after independent verification.
contract DeployCore is Script, DeploymentSafeProfile {
    uint256 internal constant TARGET_WOVEN_SUPPLY = 1_000_000_000e18;

    function run()
        external
        returns (
            CreatorLicense creatorLicense,
            CanonicalAssetRegistry assetRegistry,
            FeeSplitter splitter,
            CuratorGuardian guardian,
            BasketFactory factory
        )
    {
        require(vm.envBool("CONFIRM_DEPLOY"), "CONFIRM_DEPLOY must be true");

        uint256 expectedChainId = vm.envUint("EXPECTED_CHAIN_ID");
        require(block.chainid == expectedChainId, "unexpected chain id");
        require(expectedChainId == 56 || expectedChainId == 97, "BNB chain only");

        address wovenToken = vm.envAddress("WOVEN_TOKEN");
        address protocolSafe = vm.envAddress("PROTOCOL_SAFE");
        address treasury = vm.envAddress("TREASURY");
        address expectedSafeOwner = vm.envAddress("EXPECTED_SAFE_OWNER");

        _validateWoven(wovenToken);
        _validateSafe(protocolSafe, expectedSafeOwner);
        _validateTreasury(protocolSafe, treasury);

        vm.startBroadcast();

        creatorLicense = new CreatorLicense(IERC20(wovenToken));
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

        require(address(creatorLicense.wovenToken()) == wovenToken, "license WOVEN mismatch");
        require(assetRegistry.owner() == protocolSafe, "registry owner mismatch");
        require(assetRegistry.pendingOwner() == address(0), "unexpected pending registry owner");
        require(splitter.treasury() == protocolSafe, "splitter treasury mismatch");
        require(splitter.factory() == address(factory), "splitter factory mismatch");
        require(guardian.admin() == protocolSafe, "guardian admin mismatch");
        require(address(factory.creatorLicense()) == address(creatorLicense), "factory license mismatch");
        require(address(factory.assetRegistry()) == address(assetRegistry), "factory registry mismatch");
        require(address(factory.splitter()) == address(splitter), "factory splitter mismatch");
        require(factory.basketGuardian() == address(guardian), "factory guardian mismatch");

        vm.stopBroadcast();

        console2.log("CreatorLicense", address(creatorLicense));
        console2.log("CanonicalAssetRegistry", address(assetRegistry));
        console2.log("FeeSplitter", address(splitter));
        console2.log("CuratorGuardian", address(guardian));
        console2.log("BasketFactory", address(factory));
        console2.log("Asset registry owner", protocolSafe);
    }

    function _validateWoven(address wovenToken) internal view {
        require(wovenToken.code.length > 0, "WOVEN token not deployed");
        IFourMemeLaunchToken woven = IFourMemeLaunchToken(wovenToken);
        require(woven.totalSupply() == TARGET_WOVEN_SUPPLY, "unexpected WOVEN supply");
        require(woven.decimals() == 18, "unexpected WOVEN decimals");
        require(keccak256(bytes(woven.name())) == keccak256(bytes("Woven Stocks")), "unexpected WOVEN name");
        require(keccak256(bytes(woven.symbol())) == keccak256(bytes("WOVEN")), "unexpected WOVEN symbol");
        require(woven._mode() == 0, "WOVEN has not graduated");
        require(woven.owner() == address(0), "WOVEN ownership not renounced");
    }

    function _validateTreasury(address protocolSafe, address treasury) internal pure {
        require(treasury == protocolSafe, "treasury must be protocol Safe");
    }
}
