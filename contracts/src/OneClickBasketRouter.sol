// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IExactOutputAdapter} from "./interfaces/IExactOutputAdapter.sol";

interface IOneClickBasket {
    function balanceOf(address account) external view returns (uint256);

    function getRequiredUnits(uint256 basketAmount)
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts);

    function mint(uint256 basketAmount, address to) external;
}

interface IOneClickBasketFactory {
    function creatorOf(address basket) external view returns (address);

    function assetRegistry() external view returns (address);
}

interface IOneClickAssetRegistry {
    function isSupported(address asset) external view returns (bool);
}

/// @title OneClickBasketRouter
/// @notice Atomically buys every fixed basket constituent with USDC and mints
///         the basket token. Any failed swap or mint reverts the entire call.
/// @dev The immutable adapter set is codehash-pinned at deployment. Each adapter
///      exposes only constructor-bound exact-output routes.
contract OneClickBasketRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct SwapLeg {
        address expectedToken;
        address adapter;
        bytes32 routeId;
        uint256 expectedAmountOut;
        uint256 maxUsdcIn;
    }

    error ZeroAddress();
    error NotAContract(address target);
    error NoAdapters();
    error DuplicateAdapter(address adapter);
    error AdapterInputMismatch(address adapter, address expected, address actual);
    error ZeroAmount();
    error InvalidRecipient();
    error Expired();
    error DeadlineTooFar(uint256 deadline, uint256 maximum);
    error UnknownBasket(address basket);
    error InvalidConstituentCount(uint256 count);
    error LegCountMismatch(uint256 expected, uint256 actual);
    error UnsupportedAsset(address asset);
    error UsdcConstituentUnsupported();
    error LegTokenMismatch(uint256 index, address expected, address actual);
    error LegAmountMismatch(uint256 index, uint256 expected, uint256 actual);
    error ZeroLegMaximum(uint256 index);
    error TotalMaximumMismatch(uint256 expected, uint256 actual);
    error UnapprovedAdapter(address adapter);
    error AdapterCodeChanged(address adapter, bytes32 expected, bytes32 actual);
    error AdapterRouteMismatch(address adapter, bytes32 routeId, address expected, address actual);
    error InexactUsdcTransfer(uint256 expected, uint256 received);
    error InexactUsdcDebit(uint256 expected, uint256 debited);
    error InexactUsdcRefund(uint256 expected, uint256 received);
    error AdapterSpendMismatch(uint256 index, uint256 reported, uint256 measured);
    error LegSpendExceeded(uint256 index, uint256 spent, uint256 maximum);
    error ConstituentOutputMismatch(uint256 index, uint256 expected, uint256 received);
    error ConstituentBalanceNotRestored(address token, uint256 expected, uint256 actual);
    error BasketOutputBelowMinimum(uint256 minimum, uint256 received);
    error UsdcBalanceNotRestored(uint256 expected, uint256 actual);

    event BasketMintedWithUsdc(
        address indexed payer,
        address indexed basket,
        address indexed recipient,
        uint256 grossBasketAmount,
        uint256 netBasketOut,
        uint256 usdcSpent,
        uint256 usdcRefunded
    );

    uint256 public constant MAX_ROUTED_CONSTITUENTS = 8;
    uint256 public constant MAX_DEADLINE_WINDOW = 20 minutes;

    address public immutable usdc;
    address public immutable basketFactory;
    address public immutable assetRegistry;

    mapping(address adapter => bytes32 codehash) public adapterCodehash;
    address[] private _adapters;

    constructor(address usdc_, address basketFactory_, address[] memory adapters_) {
        if (usdc_ == address(0) || basketFactory_ == address(0)) revert ZeroAddress();
        if (usdc_.code.length == 0) revert NotAContract(usdc_);
        if (basketFactory_.code.length == 0) revert NotAContract(basketFactory_);
        if (adapters_.length == 0) revert NoAdapters();

        usdc = usdc_;
        basketFactory = basketFactory_;

        address registry = IOneClickBasketFactory(basketFactory_).assetRegistry();
        if (registry == address(0) || registry.code.length == 0) revert NotAContract(registry);
        assetRegistry = registry;

        for (uint256 i = 0; i < adapters_.length; ++i) {
            address adapter = adapters_[i];
            if (adapter == address(0)) revert ZeroAddress();
            if (adapter.code.length == 0) revert NotAContract(adapter);
            if (adapterCodehash[adapter] != bytes32(0)) revert DuplicateAdapter(adapter);

            address adapterInput = IExactOutputAdapter(adapter).inputToken();
            if (adapterInput != usdc_) revert AdapterInputMismatch(adapter, usdc_, adapterInput);
            bytes32 codehash = adapter.codehash;
            adapterCodehash[adapter] = codehash;
            _adapters.push(adapter);
        }
    }

    function adapters() external view returns (address[] memory) {
        return _adapters;
    }

    function mintWithUsdc(
        address basket,
        uint256 grossBasketAmount,
        uint256 minNetBasketOut,
        address recipient,
        uint256 maxTotalUsdcIn,
        uint256 deadline,
        SwapLeg[] calldata legs
    ) external nonReentrant returns (uint256 netBasketOut, uint256 usdcSpent) {
        if (basket == address(0)) revert ZeroAddress();
        if (basket.code.length == 0) revert NotAContract(basket);
        if (grossBasketAmount == 0 || maxTotalUsdcIn == 0) revert ZeroAmount();
        if (recipient == address(0) || recipient == address(this) || recipient == basket) revert InvalidRecipient();
        if (block.timestamp > deadline) revert Expired();
        uint256 maximumDeadline = block.timestamp + MAX_DEADLINE_WINDOW;
        if (deadline > maximumDeadline) revert DeadlineTooFar(deadline, maximumDeadline);
        if (IOneClickBasketFactory(basketFactory).creatorOf(basket) == address(0)) revert UnknownBasket(basket);

        (address[] memory tokens, uint256[] memory amounts) =
            IOneClickBasket(basket).getRequiredUnits(grossBasketAmount);
        uint256 count = tokens.length;
        if (count == 0 || count > MAX_ROUTED_CONSTITUENTS || amounts.length != count) {
            revert InvalidConstituentCount(count);
        }
        if (legs.length != count) revert LegCountMismatch(count, legs.length);

        uint256 totalMaximum = 0;
        uint256[] memory constituentBaselines = new uint256[](count);
        for (uint256 i = 0; i < count; ++i) {
            address token = tokens[i];
            SwapLeg calldata leg = legs[i];
            if (!IOneClickAssetRegistry(assetRegistry).isSupported(token)) revert UnsupportedAsset(token);
            if (token == usdc) revert UsdcConstituentUnsupported();
            if (leg.expectedToken != token) revert LegTokenMismatch(i, token, leg.expectedToken);
            if (leg.expectedAmountOut != amounts[i]) revert LegAmountMismatch(i, amounts[i], leg.expectedAmountOut);
            if (leg.maxUsdcIn == 0) revert ZeroLegMaximum(i);

            bytes32 pinnedCodehash = adapterCodehash[leg.adapter];
            if (pinnedCodehash == bytes32(0)) revert UnapprovedAdapter(leg.adapter);
            bytes32 currentCodehash = leg.adapter.codehash;
            if (currentCodehash != pinnedCodehash) {
                revert AdapterCodeChanged(leg.adapter, pinnedCodehash, currentCodehash);
            }
            address routeOutput = IExactOutputAdapter(leg.adapter).routeOutput(leg.routeId);
            if (routeOutput != token) {
                revert AdapterRouteMismatch(leg.adapter, leg.routeId, token, routeOutput);
            }

            totalMaximum += leg.maxUsdcIn;
            constituentBaselines[i] = IERC20(token).balanceOf(address(this));
        }
        if (totalMaximum != maxTotalUsdcIn) revert TotalMaximumMismatch(maxTotalUsdcIn, totalMaximum);

        IERC20 input = IERC20(usdc);
        uint256 usdcBaseline = input.balanceOf(address(this));
        uint256 payerBalanceBefore = input.balanceOf(msg.sender);
        input.safeTransferFrom(msg.sender, address(this), maxTotalUsdcIn);
        uint256 received = input.balanceOf(address(this)) - usdcBaseline;
        if (received != maxTotalUsdcIn) revert InexactUsdcTransfer(maxTotalUsdcIn, received);
        uint256 payerBalanceAfter = input.balanceOf(msg.sender);
        uint256 payerDebit =
            payerBalanceBefore >= payerBalanceAfter ? payerBalanceBefore - payerBalanceAfter : type(uint256).max;
        if (payerDebit != maxTotalUsdcIn) revert InexactUsdcDebit(maxTotalUsdcIn, payerDebit);

        for (uint256 i = 0; i < count; ++i) {
            SwapLeg calldata leg = legs[i];
            uint256 usdcBefore = input.balanceOf(address(this));
            input.forceApprove(leg.adapter, leg.maxUsdcIn);
            uint256 reportedSpend = IExactOutputAdapter(leg.adapter)
                .swapExactOutput(tokens[i], amounts[i], leg.maxUsdcIn, deadline, leg.routeId);
            input.forceApprove(leg.adapter, 0);

            uint256 usdcAfter = input.balanceOf(address(this));
            uint256 measuredSpend = usdcBefore >= usdcAfter ? usdcBefore - usdcAfter : type(uint256).max;
            if (reportedSpend != measuredSpend) revert AdapterSpendMismatch(i, reportedSpend, measuredSpend);
            if (measuredSpend > leg.maxUsdcIn) revert LegSpendExceeded(i, measuredSpend, leg.maxUsdcIn);
            usdcSpent += measuredSpend;

            uint256 tokenBalance = IERC20(tokens[i]).balanceOf(address(this));
            uint256 tokenReceived =
                tokenBalance >= constituentBaselines[i] ? tokenBalance - constituentBaselines[i] : type(uint256).max;
            if (tokenReceived != amounts[i]) revert ConstituentOutputMismatch(i, amounts[i], tokenReceived);
        }

        uint256 basketBalanceBefore = IOneClickBasket(basket).balanceOf(recipient);
        for (uint256 i = 0; i < count; ++i) {
            IERC20(tokens[i]).forceApprove(basket, amounts[i]);
        }
        IOneClickBasket(basket).mint(grossBasketAmount, recipient);
        for (uint256 i = 0; i < count; ++i) {
            IERC20 token = IERC20(tokens[i]);
            token.forceApprove(basket, 0);
            uint256 finalBalance = token.balanceOf(address(this));
            if (finalBalance != constituentBaselines[i]) {
                revert ConstituentBalanceNotRestored(tokens[i], constituentBaselines[i], finalBalance);
            }
        }

        netBasketOut = IOneClickBasket(basket).balanceOf(recipient) - basketBalanceBefore;
        if (netBasketOut < minNetBasketOut) revert BasketOutputBelowMinimum(minNetBasketOut, netBasketOut);

        uint256 refund = maxTotalUsdcIn - usdcSpent;
        if (refund > 0) {
            uint256 payerBeforeRefund = input.balanceOf(msg.sender);
            input.safeTransfer(msg.sender, refund);
            uint256 payerAfterRefund = input.balanceOf(msg.sender);
            uint256 refundReceived =
                payerAfterRefund >= payerBeforeRefund ? payerAfterRefund - payerBeforeRefund : type(uint256).max;
            if (refundReceived != refund) revert InexactUsdcRefund(refund, refundReceived);
        }
        uint256 finalUsdcBalance = input.balanceOf(address(this));
        if (finalUsdcBalance != usdcBaseline) revert UsdcBalanceNotRestored(usdcBaseline, finalUsdcBalance);

        emit BasketMintedWithUsdc(msg.sender, basket, recipient, grossBasketAmount, netBasketOut, usdcSpent, refund);
    }
}
