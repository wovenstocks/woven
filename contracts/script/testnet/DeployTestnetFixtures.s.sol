// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {BStockTestnetFixture, WovenTestnetFixture} from "./TestnetFixtureTokens.sol";

/// @notice Deploys non-production token fixtures for the Woven core flow.
/// @dev This script never deploys protocol contracts or changes a registry. It
///      requires explicit confirmation and permits only local Anvil or BSC
///      testnet. Every token constructor independently enforces the same guard.
contract DeployTestnetFixtures is Script {
    error FixtureChainNotAllowed(uint256 chainId);
    error FixtureChainMismatch(uint256 expectedChainId, uint256 actualChainId);

    uint256 internal constant BSC_TESTNET_CHAIN_ID = 97;
    uint256 internal constant LOCAL_ANVIL_CHAIN_ID = 31_337;

    function run()
        external
        returns (
            WovenTestnetFixture woven,
            BStockTestnetFixture nvdab,
            BStockTestnetFixture msftb,
            BStockTestnetFixture tslab,
            BStockTestnetFixture qqqb
        )
    {
        require(vm.envBool("CONFIRM_TESTNET_FIXTURE_DEPLOY"), "fixture deployment not confirmed");
        _validateChain(vm.envUint("FIXTURE_EXPECTED_CHAIN_ID"));

        address recipient = vm.envAddress("TESTNET_FIXTURE_RECIPIENT");
        require(recipient != address(0), "fixture recipient is zero");

        vm.startBroadcast();
        (woven, nvdab, msftb, tslab, qqqb) = _deploy(recipient);
        vm.stopBroadcast();

        _validateDeployment(recipient, woven, nvdab, msftb, tslab, qqqb);

        console2.log("TESTNET FIXTURE WOVEN", address(woven));
        console2.log("TESTNET FIXTURE NVDAB", address(nvdab));
        console2.log("TESTNET FIXTURE MSFTB", address(msftb));
        console2.log("TESTNET FIXTURE TSLAB", address(tslab));
        console2.log("TESTNET FIXTURE QQQB", address(qqqb));
    }

    function _validateChain(uint256 expectedChainId) internal view {
        if (expectedChainId != BSC_TESTNET_CHAIN_ID && expectedChainId != LOCAL_ANVIL_CHAIN_ID) {
            revert FixtureChainNotAllowed(expectedChainId);
        }
        if (block.chainid != expectedChainId) {
            revert FixtureChainMismatch(expectedChainId, block.chainid);
        }
    }

    function _deploy(address recipient)
        internal
        returns (
            WovenTestnetFixture woven,
            BStockTestnetFixture nvdab,
            BStockTestnetFixture msftb,
            BStockTestnetFixture tslab,
            BStockTestnetFixture qqqb
        )
    {
        woven = new WovenTestnetFixture(recipient);
        nvdab = new BStockTestnetFixture("TESTNET FIXTURE NVIDIA bStock", "NVDAB", recipient);
        msftb = new BStockTestnetFixture("TESTNET FIXTURE Microsoft bStock", "MSFTB", recipient);
        tslab = new BStockTestnetFixture("TESTNET FIXTURE Tesla bStock", "TSLAB", recipient);
        qqqb = new BStockTestnetFixture("TESTNET FIXTURE Nasdaq-100 ETF bStock", "QQQB", recipient);
    }

    function _validateDeployment(
        address recipient,
        WovenTestnetFixture woven,
        BStockTestnetFixture nvdab,
        BStockTestnetFixture msftb,
        BStockTestnetFixture tslab,
        BStockTestnetFixture qqqb
    ) internal view {
        require(woven.balanceOf(recipient) == woven.FIXTURE_SUPPLY(), "WOVEN fixture supply mismatch");

        BStockTestnetFixture[4] memory assets = [nvdab, msftb, tslab, qqqb];
        for (uint256 i = 0; i < assets.length; ++i) {
            require(assets[i].balanceOf(recipient) == assets[i].FIXTURE_SUPPLY(), "bStock fixture supply mismatch");
            require(assets[i].uiMultiplier() == 1e18, "bStock fixture multiplier mismatch");
            require(assets[i].toUIAmount(1e18) == 1e18, "bStock fixture conversion mismatch");
        }
    }
}
