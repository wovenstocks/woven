// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title CanonicalAssetRegistry — allowlist for verified BNB bStock tokens
/// @notice The registry is consulted only when a new basket is deployed. It
///         cannot change holdings or redemption behavior of existing baskets.
contract CanonicalAssetRegistry is Ownable2Step {
    error ZeroAddress();
    error NotAContract(address asset);
    error OwnershipRenunciationDisabled();

    event AssetStatusSet(address indexed asset, bool supported);

    mapping(address asset => bool) public isSupported;

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice The registry must always remain recoverable by a Safe owner.
    function renounceOwnership() public pure override {
        revert OwnershipRenunciationDisabled();
    }

    function setAsset(address asset, bool supported) external onlyOwner {
        if (asset == address(0)) revert ZeroAddress();
        if (supported && asset.code.length == 0) revert NotAContract(asset);
        isSupported[asset] = supported;
        emit AssetStatusSet(asset, supported);
    }

    function setAssets(address[] calldata assets, bool supported) external onlyOwner {
        uint256 n = assets.length;
        for (uint256 i = 0; i < n; ++i) {
            address asset = assets[i];
            if (asset == address(0)) revert ZeroAddress();
            if (supported && asset.code.length == 0) revert NotAContract(asset);
            isSupported[asset] = supported;
            emit AssetStatusSet(asset, supported);
        }
    }
}
