// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IExactOutputAdapter} from "../interfaces/IExactOutputAdapter.sol";
import {IExactOutputQuoter} from "../interfaces/IExactOutputQuoter.sol";

interface IPancakeV3SwapRouter {
    struct ExactOutputParams {
        bytes path;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
    }

    function exactOutput(ExactOutputParams calldata params) external payable returns (uint256 amountIn);
}

interface IPancakeV3QuoterV2 {
    function quoteExactOutput(bytes memory path, uint256 amountOut)
        external
        returns (
            uint256 amountIn,
            uint160[] memory sqrtPriceX96AfterList,
            uint32[] memory initializedTicksCrossedList,
            uint256 gasEstimate
        );
}

/// @title PancakeV3ExactOutputAdapter
/// @notice Immutable, route-bound PancakeSwap SmartRouter V3 exact-output adapter.
/// @dev Exact-output V3 paths are stored in reverse order: output token first,
///      immutable input token last. The Woven router enforces the deadline before
///      calling this adapter; the current Pancake SmartRouter V3 selector has no
///      deadline field in ExactOutputParams.
contract PancakeV3ExactOutputAdapter is IExactOutputAdapter, IExactOutputQuoter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct RouteConfig {
        bytes32 id;
        bytes path;
    }

    error ZeroAddress();
    error NotAContract(address target);
    error NoRoutes();
    error InvalidRouteId();
    error DuplicateRouteId(bytes32 routeId);
    error InvalidPathLength(uint256 length);
    error InvalidPathEndpoint();
    error InvalidPathToken(uint256 index);
    error InvalidPoolFee(uint256 index);
    error DuplicatePathToken(address token);
    error RouteNotFound(bytes32 routeId);
    error RouteOutputMismatch(address expected, address actual);
    error ZeroAmount();
    error Expired();
    error InexactInputTransfer(uint256 expected, uint256 received);
    error InexactCallerDebit(uint256 expected, uint256 debited);
    error InexactRefund(uint256 expected, uint256 received);
    error InvalidSwapResult();
    error InputSpendMismatch(uint256 reported, uint256 measured);
    error OutputAmountMismatch(uint256 expected, uint256 received);
    error ResidualInput(uint256 expected, uint256 actual);
    error DexCodeChanged(bytes32 expected, bytes32 actual);

    uint256 public constant MAX_HOPS = 4;
    uint256 private constant ADDRESS_SIZE = 20;
    uint256 private constant FEE_SIZE = 3;
    uint256 private constant NEXT_OFFSET = ADDRESS_SIZE + FEE_SIZE;

    address public immutable override inputToken;
    address public immutable dexRouter;
    address public immutable quoter;
    bytes32 public immutable dexRouterCodehash;
    bytes32 public immutable quoterCodehash;

    mapping(bytes32 routeId => address output) public override routeOutput;
    mapping(bytes32 routeId => bytes32 hash) public override routeHash;
    mapping(bytes32 routeId => bytes path) private _routes;
    bytes32[] private _routeIds;

    constructor(address inputToken_, address dexRouter_, address quoter_, RouteConfig[] memory routes_) {
        if (inputToken_ == address(0) || dexRouter_ == address(0) || quoter_ == address(0)) revert ZeroAddress();
        if (inputToken_.code.length == 0) revert NotAContract(inputToken_);
        if (dexRouter_.code.length == 0) revert NotAContract(dexRouter_);
        if (quoter_.code.length == 0) revert NotAContract(quoter_);
        if (routes_.length == 0) revert NoRoutes();

        inputToken = inputToken_;
        dexRouter = dexRouter_;
        quoter = quoter_;
        dexRouterCodehash = dexRouter_.codehash;
        quoterCodehash = quoter_.codehash;

        for (uint256 i = 0; i < routes_.length; ++i) {
            RouteConfig memory config = routes_[i];
            if (config.id == bytes32(0)) revert InvalidRouteId();
            if (routeOutput[config.id] != address(0)) revert DuplicateRouteId(config.id);
            _validatePath(config.path, inputToken_);

            address output = _addressAt(config.path, 0);
            routeOutput[config.id] = output;
            routeHash[config.id] = keccak256(config.path);
            _routes[config.id] = config.path;
            _routeIds.push(config.id);
        }
    }

    function routeIds() external view returns (bytes32[] memory) {
        return _routeIds;
    }

    function route(bytes32 routeId) external view returns (bytes memory) {
        if (routeOutput[routeId] == address(0)) revert RouteNotFound(routeId);
        return _routes[routeId];
    }

    function quoteExactOutput(address tokenOut, uint256 exactAmountOut, bytes32 routeId)
        external
        returns (uint256 amountIn, uint256 gasEstimate)
    {
        address configuredOutput = routeOutput[routeId];
        if (configuredOutput == address(0)) revert RouteNotFound(routeId);
        if (configuredOutput != tokenOut) revert RouteOutputMismatch(configuredOutput, tokenOut);
        if (exactAmountOut == 0) revert ZeroAmount();
        bytes32 currentQuoterCodehash = quoter.codehash;
        if (currentQuoterCodehash != quoterCodehash) revert DexCodeChanged(quoterCodehash, currentQuoterCodehash);

        uint160[] memory sqrtPricesAfter;
        uint32[] memory initializedTicksCrossed;
        (amountIn, sqrtPricesAfter, initializedTicksCrossed, gasEstimate) =
            IPancakeV3QuoterV2(quoter).quoteExactOutput(_routes[routeId], exactAmountOut);
        uint256 expectedHops = (_routes[routeId].length - ADDRESS_SIZE) / NEXT_OFFSET;
        if (
            amountIn == 0 || gasEstimate == 0 || sqrtPricesAfter.length != expectedHops
                || initializedTicksCrossed.length != expectedHops
        ) {
            revert InvalidSwapResult();
        }
    }

    function swapExactOutput(
        address tokenOut,
        uint256 exactAmountOut,
        uint256 maxAmountIn,
        uint256 deadline,
        bytes32 routeId
    ) external nonReentrant returns (uint256 amountIn) {
        address configuredOutput = routeOutput[routeId];
        if (configuredOutput == address(0)) revert RouteNotFound(routeId);
        if (configuredOutput != tokenOut) revert RouteOutputMismatch(configuredOutput, tokenOut);
        if (exactAmountOut == 0 || maxAmountIn == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert Expired();
        bytes32 currentDexCodehash = dexRouter.codehash;
        if (currentDexCodehash != dexRouterCodehash) revert DexCodeChanged(dexRouterCodehash, currentDexCodehash);

        IERC20 input = IERC20(inputToken);
        IERC20 output = IERC20(tokenOut);
        uint256 inputBaseline = input.balanceOf(address(this));
        uint256 callerInputBefore = input.balanceOf(msg.sender);
        uint256 outputBefore = output.balanceOf(msg.sender);

        input.safeTransferFrom(msg.sender, address(this), maxAmountIn);
        uint256 received = input.balanceOf(address(this)) - inputBaseline;
        if (received != maxAmountIn) revert InexactInputTransfer(maxAmountIn, received);
        uint256 callerInputAfter = input.balanceOf(msg.sender);
        uint256 callerDebit =
            callerInputBefore >= callerInputAfter ? callerInputBefore - callerInputAfter : type(uint256).max;
        if (callerDebit != maxAmountIn) revert InexactCallerDebit(maxAmountIn, callerDebit);

        input.forceApprove(dexRouter, maxAmountIn);
        amountIn = IPancakeV3SwapRouter(dexRouter)
            .exactOutput(
                IPancakeV3SwapRouter.ExactOutputParams({
                path: _routes[routeId], recipient: msg.sender, amountOut: exactAmountOut, amountInMaximum: maxAmountIn
            })
            );
        input.forceApprove(dexRouter, 0);

        uint256 balanceAfterSwap = input.balanceOf(address(this));
        if (balanceAfterSwap > inputBaseline + maxAmountIn) revert InvalidSwapResult();
        uint256 measuredSpend = inputBaseline + maxAmountIn - balanceAfterSwap;
        if (amountIn > maxAmountIn || amountIn != measuredSpend) {
            revert InputSpendMismatch(amountIn, measuredSpend);
        }

        uint256 outputReceived = output.balanceOf(msg.sender) - outputBefore;
        if (outputReceived != exactAmountOut) revert OutputAmountMismatch(exactAmountOut, outputReceived);

        uint256 refund = maxAmountIn - amountIn;
        if (refund > 0) {
            uint256 callerBeforeRefund = input.balanceOf(msg.sender);
            input.safeTransfer(msg.sender, refund);
            uint256 callerAfterRefund = input.balanceOf(msg.sender);
            uint256 refundReceived =
                callerAfterRefund >= callerBeforeRefund ? callerAfterRefund - callerBeforeRefund : type(uint256).max;
            if (refundReceived != refund) revert InexactRefund(refund, refundReceived);
        }
        uint256 finalBalance = input.balanceOf(address(this));
        if (finalBalance != inputBaseline) revert ResidualInput(inputBaseline, finalBalance);
    }

    function _validatePath(bytes memory path, address expectedInput) private view {
        uint256 length = path.length;
        if (length < ADDRESS_SIZE + FEE_SIZE + ADDRESS_SIZE || (length - ADDRESS_SIZE) % NEXT_OFFSET != 0) {
            revert InvalidPathLength(length);
        }

        uint256 hops = (length - ADDRESS_SIZE) / NEXT_OFFSET;
        if (hops > MAX_HOPS) revert InvalidPathLength(length);
        address output = _addressAt(path, 0);
        address input = _addressAt(path, length - ADDRESS_SIZE);
        if (output == address(0) || input != expectedInput || output == expectedInput) revert InvalidPathEndpoint();

        for (uint256 i = 0; i <= hops; ++i) {
            address token = _addressAt(path, i * NEXT_OFFSET);
            if (token == address(0) || token.code.length == 0) revert InvalidPathToken(i);
            for (uint256 j = 0; j < i; ++j) {
                if (_addressAt(path, j * NEXT_OFFSET) == token) revert DuplicatePathToken(token);
            }
            if (i < hops && _uint24At(path, i * NEXT_OFFSET + ADDRESS_SIZE) == 0) {
                revert InvalidPoolFee(i);
            }
        }
    }

    function _addressAt(bytes memory data, uint256 offset) private pure returns (address result) {
        assembly ("memory-safe") {
            result := shr(96, mload(add(add(data, 0x20), offset)))
        }
    }

    function _uint24At(bytes memory data, uint256 offset) private pure returns (uint24 result) {
        assembly ("memory-safe") {
            result := shr(232, mload(add(add(data, 0x20), offset)))
        }
    }
}
