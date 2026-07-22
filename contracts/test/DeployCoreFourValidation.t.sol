// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {DeployCoreFour, ICoreFourRegistry} from "../script/DeployCoreFour.s.sol";

contract DeployCoreFourHarness is DeployCoreFour {
    function validateRegistryOwnership(address registry, address protocolSafe) external view {
        _validateRegistryOwnership(ICoreFourRegistry(registry), protocolSafe);
    }
}

contract MockCoreFourRegistryOwnership {
    address public owner;
    address public pendingOwner;

    constructor(address owner_) {
        owner = owner_;
    }

    function setPendingOwner(address pendingOwner_) external {
        pendingOwner = pendingOwner_;
    }
}

contract DeployCoreFourValidationTest is Test {
    DeployCoreFourHarness internal harness;
    MockCoreFourRegistryOwnership internal registry;
    address internal protocolSafe = makeAddr("protocolSafe");

    function setUp() public {
        harness = new DeployCoreFourHarness();
        registry = new MockCoreFourRegistryOwnership(protocolSafe);
    }

    function test_acceptsSettledRegistryOwnership() public view {
        harness.validateRegistryOwnership(address(registry), protocolSafe);
    }

    function test_rejectsWrongRegistryOwner() public {
        vm.expectRevert(bytes("registry owner is not protocol Safe"));
        harness.validateRegistryOwnership(address(registry), makeAddr("wrongSafe"));
    }

    function test_rejectsPendingRegistryOwner() public {
        registry.setPendingOwner(makeAddr("pendingOwner"));

        vm.expectRevert(bytes("unexpected pending registry owner"));
        harness.validateRegistryOwnership(address(registry), protocolSafe);
    }
}
