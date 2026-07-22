// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {DeployCore} from "../script/DeployCore.s.sol";

contract DeployCoreHarness is DeployCore {
    function validateWoven(address wovenToken) external view {
        _validateWoven(wovenToken);
    }

    function validateSafe(address protocolSafe, address expectedOwner) external view {
        _validateSafeProfile(protocolSafe, expectedOwner);
    }

    function validateCanonicalSafe(address protocolSafe, address expectedOwner) external view {
        _validateSafe(protocolSafe, expectedOwner);
    }

    function validateTreasury(address protocolSafe, address treasury) external pure {
        _validateTreasury(protocolSafe, treasury);
    }
}

contract MockLaunchWoven is ERC20 {
    uint256 public _mode;
    address public owner;

    constructor() ERC20("Woven Stocks", "WOVEN") {
        _mint(msg.sender, 1_000_000_000e18);
    }

    function setMode(uint256 mode_) external {
        _mode = mode_;
    }

    function setOwner(address owner_) external {
        owner = owner_;
    }
}

contract MockSafeLaunchProfile {
    address internal constant SENTINEL = address(0x1);
    bytes32 internal constant GUARD_STORAGE_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    bytes32 internal constant FALLBACK_HANDLER_STORAGE_SLOT =
        0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;

    address public singleton = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    string public version = "1.4.1";
    uint256 public threshold = 1;
    address public guard;
    address public fallbackHandler = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    address[] internal _owners;
    address[] internal _modules;

    constructor(address owner_) {
        _owners.push(owner_);
    }

    function VERSION() external view returns (string memory) {
        return version;
    }

    function masterCopy() external view returns (address) {
        return singleton;
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory modules, address next)
    {
        require(start == SENTINEL && pageSize > 0, "invalid page");
        modules = _modules;
        next = SENTINEL;
    }

    function getStorageAt(uint256 offset, uint256 length) external view returns (bytes memory) {
        require(length == 1, "invalid length");
        address value;
        if (bytes32(offset) == GUARD_STORAGE_SLOT) value = guard;
        if (bytes32(offset) == FALLBACK_HANDLER_STORAGE_SLOT) value = fallbackHandler;
        return abi.encode(bytes32(uint256(uint160(value))));
    }

    function setOwner(address owner_) external {
        delete _owners;
        _owners.push(owner_);
    }

    function addOwner(address owner_) external {
        _owners.push(owner_);
    }

    function addModule(address module_) external {
        _modules.push(module_);
    }

    function setThreshold(uint256 threshold_) external {
        threshold = threshold_;
    }

    function setSingleton(address singleton_) external {
        singleton = singleton_;
    }

    function setVersion(string calldata version_) external {
        version = version_;
    }

    function setGuard(address guard_) external {
        guard = guard_;
    }

    function setFallbackHandler(address fallbackHandler_) external {
        fallbackHandler = fallbackHandler_;
    }
}

contract DeployCoreValidationTest is Test {
    address internal owner = makeAddr("owner");
    DeployCoreHarness internal harness;
    MockLaunchWoven internal woven;
    MockSafeLaunchProfile internal safe;

    function setUp() public {
        harness = new DeployCoreHarness();
        woven = new MockLaunchWoven();
        safe = new MockSafeLaunchProfile(owner);
    }

    function test_acceptsGraduatedFourMemeWovenAndCanonicalOneOfOneSafe() public view {
        harness.validateWoven(address(woven));
        harness.validateSafe(address(safe), owner);
        harness.validateTreasury(address(safe), address(safe));
    }

    function test_rejectsWovenBeforeGraduationOrOwnershipRenunciation() public {
        woven.setMode(1);
        vm.expectRevert(bytes("WOVEN has not graduated"));
        harness.validateWoven(address(woven));

        woven.setMode(0);
        woven.setOwner(makeAddr("tokenManager"));
        vm.expectRevert(bytes("WOVEN ownership not renounced"));
        harness.validateWoven(address(woven));
    }

    function test_rejectsWrongSafeOwnerSetAndThreshold() public {
        safe.setOwner(makeAddr("wrongOwner"));
        vm.expectRevert(bytes("unexpected Safe owner set"));
        harness.validateSafe(address(safe), owner);

        safe.setOwner(owner);
        safe.addOwner(makeAddr("secondOwner"));
        vm.expectRevert(bytes("unexpected Safe owner set"));
        harness.validateSafe(address(safe), owner);

        safe = new MockSafeLaunchProfile(owner);
        safe.setThreshold(2);
        vm.expectRevert(bytes("unexpected Safe threshold"));
        harness.validateSafe(address(safe), owner);
    }

    function test_rejectsWrongSafeImplementationAndVersion() public {
        safe.setSingleton(makeAddr("wrongSingleton"));
        vm.expectRevert(bytes("unexpected Safe singleton"));
        harness.validateSafe(address(safe), owner);

        safe.setSingleton(0x29fcB43b46531BcA003ddC8FCB67FFE91900C762);
        safe.setVersion("1.3.0");
        vm.expectRevert(bytes("unexpected Safe version"));
        harness.validateSafe(address(safe), owner);
    }

    function test_rejectsSafeModuleGuardOrFallbackHandler() public {
        safe.addModule(makeAddr("module"));
        vm.expectRevert(bytes("Safe modules must be empty"));
        harness.validateSafe(address(safe), owner);

        safe = new MockSafeLaunchProfile(owner);
        safe.setGuard(makeAddr("guard"));
        vm.expectRevert(bytes("Safe guard must be empty"));
        harness.validateSafe(address(safe), owner);

        safe.setGuard(address(0));
        safe.setFallbackHandler(address(0));
        vm.expectRevert(bytes("unexpected Safe fallback handler"));
        harness.validateSafe(address(safe), owner);
    }

    function test_rejectsSeparateTreasuryForSingleWalletProfile() public {
        vm.expectRevert(bytes("treasury must be protocol Safe"));
        harness.validateTreasury(address(safe), makeAddr("treasury"));
    }

    function testFork_acceptsCanonicalSafeRuntimeAndProfile() public {
        if (!vm.envOr("RUN_SAFE_BSC_FORK", false)) return;

        string memory rpcUrl = vm.envString("WOVEN_BNB_RPC_URL");
        uint256 forkBlock = vm.envOr("SAFE_BSC_FORK_BLOCK", uint256(0));
        if (forkBlock == 0) {
            vm.createSelectFork(rpcUrl);
        } else {
            vm.createSelectFork(rpcUrl, forkBlock);
        }
        DeployCoreHarness forkHarness = new DeployCoreHarness();
        forkHarness.validateCanonicalSafe(vm.envAddress("PROTOCOL_SAFE"), vm.envAddress("EXPECTED_SAFE_OWNER"));
    }
}
