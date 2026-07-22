// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BasketToken} from "./BasketToken.sol";
import {FeeSplitter} from "./FeeSplitter.sol";

interface ICreatorLicense {
    function isLicensed(address creator) external view returns (bool);
}

interface ICanonicalAssetRegistry {
    function isSupported(address asset) external view returns (bool);
}

/// @title BasketFactory — licensed creation of canonical bStock baskets
/// @notice Every deployed basket uses the same immutable backing contract,
///         restricted guardian, and immutable 60/40 fee destination.
contract BasketFactory {
    error NotLicensed();
    error UnsupportedAsset(address asset);
    error CapAboveFactoryLimit();
    error PageSizeTooLarge(uint256 requested, uint256 maximum);
    error ZeroAddress();

    event BasketCreated(
        address indexed basket, address indexed creator, string name, string symbol, uint256 initialSupplyCap
    );

    uint256 public constant STARTER_CAP = 1_000e18;
    uint256 public constant CEILING = 1_000_000e18;
    uint256 public constant MAX_PAGE_SIZE = 100;

    ICreatorLicense public immutable creatorLicense;
    ICanonicalAssetRegistry public immutable assetRegistry;
    FeeSplitter public immutable splitter;
    address public immutable basketGuardian;

    address[] private _baskets;
    mapping(address basket => address creator) public creatorOf;

    constructor(
        ICreatorLicense creatorLicense_,
        ICanonicalAssetRegistry assetRegistry_,
        FeeSplitter splitter_,
        address basketGuardian_
    ) {
        if (
            address(creatorLicense_) == address(0) || address(assetRegistry_) == address(0)
                || address(splitter_) == address(0) || basketGuardian_ == address(0)
        ) revert ZeroAddress();

        creatorLicense = creatorLicense_;
        assetRegistry = assetRegistry_;
        splitter = splitter_;
        basketGuardian = basketGuardian_;
    }

    function createBasket(
        string calldata name,
        string calldata symbol,
        address[] calldata tokens,
        uint256[] calldata unitsPerBasket,
        uint16 mintFeeBps,
        uint256 initialSupplyCap
    ) external returns (address basket) {
        if (!creatorLicense.isLicensed(msg.sender)) revert NotLicensed();
        if (initialSupplyCap > STARTER_CAP) revert CapAboveFactoryLimit();

        uint256 n = tokens.length;
        for (uint256 i = 0; i < n; ++i) {
            if (!assetRegistry.isSupported(tokens[i])) revert UnsupportedAsset(tokens[i]);
        }

        basket = address(
            new BasketToken(
                name,
                symbol,
                tokens,
                unitsPerBasket,
                mintFeeBps,
                address(splitter),
                basketGuardian,
                CEILING,
                initialSupplyCap
            )
        );

        creatorOf[basket] = msg.sender;
        _baskets.push(basket);
        emit BasketCreated(basket, msg.sender, name, symbol, initialSupplyCap);

        splitter.register(basket, msg.sender);
    }

    function basketCount() external view returns (uint256) {
        return _baskets.length;
    }

    /// @notice Returns at most `limit` basket addresses beginning at `offset`.
    /// @dev A bounded page prevents index reads from growing with the full factory history.
    function basketsPage(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        if (limit > MAX_PAGE_SIZE) revert PageSizeTooLarge(limit, MAX_PAGE_SIZE);

        uint256 length = _baskets.length;
        if (limit == 0 || offset >= length) return new address[](0);

        uint256 remaining = length - offset;
        uint256 pageLength = limit < remaining ? limit : remaining;
        page = new address[](pageLength);

        for (uint256 i = 0; i < pageLength; ++i) {
            page[i] = _baskets[offset + i];
        }
    }
}
