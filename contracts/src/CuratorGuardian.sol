// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IGuardianManagedBasket {
    function guardian() external view returns (address);
}

interface IBasketCap is IGuardianManagedBasket {
    function setSupplyCap(uint256 newCap) external;
    function supplyCap() external view returns (uint256);
}

interface IBasketMintPause is IGuardianManagedBasket {
    function setMintPaused(bool paused) external;
    function mintPaused() external view returns (bool);
}

/// @title CuratorGuardian — restricted cap and mint-pause controller
/// @notice The immutable admin can raise a basket cap and toggle minting. This
///         contract cannot redirect fees, block redemption, or touch backing.
/// @dev Adapted from Vimen's MIT-licensed CuratorGuardian.
contract CuratorGuardian {
    error NotAdmin();
    error ZeroAddress();
    error InvalidBasket();
    error UnmanagedBasket();
    error CapNotIncreasing();
    error CapStateMismatch();
    error PauseStateMismatch();

    event CapRaised(address indexed basket, uint256 newCap);
    event MintPauseSet(address indexed basket, bool paused);

    address public immutable admin;

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    function raiseCap(IBasketCap basket, uint256 newCap) external onlyAdmin {
        _requireManagedBasket(address(basket));
        if (newCap <= basket.supplyCap()) revert CapNotIncreasing();
        basket.setSupplyCap(newCap);
        if (basket.supplyCap() != newCap) revert CapStateMismatch();
        emit CapRaised(address(basket), newCap);
    }

    function setMintPaused(IBasketMintPause basket, bool paused) external onlyAdmin {
        _requireManagedBasket(address(basket));
        basket.setMintPaused(paused);
        if (basket.mintPaused() != paused) revert PauseStateMismatch();
        emit MintPauseSet(address(basket), paused);
    }

    function _requireManagedBasket(address basket) private view {
        if (basket.code.length == 0) revert InvalidBasket();

        address configuredGuardian = address(0);
        try IGuardianManagedBasket(basket).guardian() returns (address guardian_) {
            configuredGuardian = guardian_;
        } catch {
            revert InvalidBasket();
        }

        if (configuredGuardian != address(this)) revert UnmanagedBasket();
    }
}
