// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ISafeDeploymentProfile {
    function VERSION() external view returns (string memory);
    function masterCopy() external view returns (address);
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory modules, address next);
    function getStorageAt(uint256 offset, uint256 length) external view returns (bytes memory);
}

/// @notice Shared, fail-closed validation for the single-owner protocol Safe.
/// @dev Runtime hashes pin the canonical Safe v1.4.1 L2 deployment artifacts
///      observed at the fixed addresses on BNB mainnet and BNB testnet.
abstract contract DeploymentSafeProfile {
    address internal constant SAFE_SENTINEL = address(0x1);
    address internal constant SAFE_L2_V1_4_1 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant SAFE_COMPATIBILITY_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;

    bytes32 internal constant SAFE_PROXY_RUNTIME_CODEHASH =
        0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c;
    bytes32 internal constant SAFE_SINGLETON_RUNTIME_CODEHASH =
        0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff;
    bytes32 internal constant SAFE_PROXY_FACTORY_RUNTIME_CODEHASH =
        0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317;
    bytes32 internal constant SAFE_FALLBACK_HANDLER_RUNTIME_CODEHASH =
        0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9;

    bytes32 internal constant SAFE_GUARD_STORAGE_SLOT =
        0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    bytes32 internal constant SAFE_FALLBACK_HANDLER_STORAGE_SLOT =
        0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;

    function _validateSafe(address protocolSafe, address expectedOwner) internal view {
        require(SAFE_L2_V1_4_1.codehash == SAFE_SINGLETON_RUNTIME_CODEHASH, "unexpected Safe singleton codehash");
        require(
            SAFE_PROXY_FACTORY.codehash == SAFE_PROXY_FACTORY_RUNTIME_CODEHASH, "unexpected Safe proxy factory codehash"
        );
        require(
            SAFE_COMPATIBILITY_FALLBACK_HANDLER.codehash == SAFE_FALLBACK_HANDLER_RUNTIME_CODEHASH,
            "unexpected Safe fallback handler codehash"
        );
        require(protocolSafe.codehash == SAFE_PROXY_RUNTIME_CODEHASH, "unexpected Safe proxy codehash");
        _validateSafeProfile(protocolSafe, expectedOwner);
    }

    /// @dev Separated from runtime pins so local tests can exercise every
    ///      mutable Safe-profile rejection branch with a purpose-built mock.
    function _validateSafeProfile(address protocolSafe, address expectedOwner) internal view {
        require(protocolSafe != address(0) && expectedOwner != address(0), "zero Safe input");
        require(protocolSafe.code.length > 0, "protocol Safe must be a contract");

        ISafeDeploymentProfile safe = ISafeDeploymentProfile(protocolSafe);
        require(safe.masterCopy() == SAFE_L2_V1_4_1, "unexpected Safe singleton");
        require(keccak256(bytes(safe.VERSION())) == keccak256(bytes("1.4.1")), "unexpected Safe version");

        address[] memory owners = safe.getOwners();
        require(owners.length == 1 && owners[0] == expectedOwner, "unexpected Safe owner set");
        require(safe.getThreshold() == 1, "unexpected Safe threshold");

        (address[] memory modules, address next) = safe.getModulesPaginated(SAFE_SENTINEL, 1);
        require(modules.length == 0 && next == SAFE_SENTINEL, "Safe modules must be empty");
        require(_safeStorageAddress(safe, SAFE_GUARD_STORAGE_SLOT) == address(0), "Safe guard must be empty");
        require(
            _safeStorageAddress(safe, SAFE_FALLBACK_HANDLER_STORAGE_SLOT) == SAFE_COMPATIBILITY_FALLBACK_HANDLER,
            "unexpected Safe fallback handler"
        );
    }

    function _safeStorageAddress(ISafeDeploymentProfile safe, bytes32 slot) private view returns (address value) {
        bytes memory raw = safe.getStorageAt(uint256(slot), 1);
        require(raw.length == 32, "invalid Safe storage response");
        value = address(uint160(uint256(abi.decode(raw, (bytes32)))));
    }
}
