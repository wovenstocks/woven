// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IExactOutputAdapter} from "../interfaces/IExactOutputAdapter.sol";
import {IExactOutputQuoter} from "../interfaces/IExactOutputQuoter.sol";

interface IPancakeV2Router {
    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function getAmountsIn(uint256 amountOut, address[] calldata path) external view returns (uint256[] memory amounts);
}

/// @title PancakeV2ExactOutputAdapter
/// @notice Immutable, route-bound PancakeSwap V2 exact-output adapter.
/// @dev Routes are fixed at deployment. Callers cannot supply a target,
///      recipient, selector, or arbitrary calldata.
contract PancakeV2ExactOutputAdapter is IExactOutputAdapter, IExactOutputQuoter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct RouteConfig {
        bytes32 id;
        address[] path;
    }

    error ZeroAddress();
    error NotAContract(address target);
    error NoRoutes();
    error InvalidRouteId();
    error DuplicateRouteId(bytes32 routeId);
    error InvalidPathLength(uint256 length);
    error InvalidPathEndpoint();
    error InvalidPathToken(uint256 index);
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

    address public immutable override inputToken;
    address public immutable dexRouter;
    bytes32 public immutable dexRouterCodehash;

    mapping(bytes32 routeId => address output) public override routeOutput;
    mapping(bytes32 routeId => bytes32 hash) public override routeHash;
    mapping(bytes32 routeId => address[] path) private _routes;
    bytes32[] private _routeIds;

    constructor(address inputToken_, address dexRouter_, RouteConfig[] memory routes_) {
        if (inputToken_ == address(0) || dexRouter_ == address(0)) revert ZeroAddress();
        if (inputToken_.code.length == 0) revert NotAContract(inputToken_);
        if (dexRouter_.code.length == 0) revert NotAContract(dexRouter_);
        if (routes_.length == 0) revert NoRoutes();

        inputToken = inputToken_;
        dexRouter = dexRouter_;
        dexRouterCodehash = dexRouter_.codehash;

        for (uint256 i = 0; i < routes_.length; ++i) {
            RouteConfig memory config = routes_[i];
            if (config.id == bytes32(0)) revert InvalidRouteId();
            if (routeOutput[config.id] != address(0)) revert DuplicateRouteId(config.id);

            uint256 length = config.path.length;
            if (length < 2 || length > MAX_HOPS + 1) revert InvalidPathLength(length);
            if (config.path[0] != inputToken_) revert InvalidPathEndpoint();

            for (uint256 j = 0; j < length; ++j) {
                address token = config.path[j];
                if (token == address(0) || token.code.length == 0) revert InvalidPathToken(j);
                for (uint256 k = 0; k < j; ++k) {
                    if (config.path[k] == token) revert DuplicatePathToken(token);
                }
                _routes[config.id].push(token);
            }

            address output = config.path[length - 1];
            if (output == inputToken_) revert InvalidPathEndpoint();
            routeOutput[config.id] = output;
            routeHash[config.id] = keccak256(abi.encode(config.path));
            _routeIds.push(config.id);
        }
    }

    function routeIds() external view returns (bytes32[] memory) {
        return _routeIds;
    }

    function route(bytes32 routeId) external view returns (address[] memory) {
        if (routeOutput[routeId] == address(0)) revert RouteNotFound(routeId);
        return _routes[routeId];
    }

    function quoteExactOutput(address tokenOut, uint256 exactAmountOut, bytes32 routeId)
        external
        view
        returns (uint256 amountIn, uint256 gasEstimate)
    {
        address configuredOutput = routeOutput[routeId];
        if (configuredOutput == address(0)) revert RouteNotFound(routeId);
        if (configuredOutput != tokenOut) revert RouteOutputMismatch(configuredOutput, tokenOut);
        if (exactAmountOut == 0) revert ZeroAmount();
        bytes32 currentDexCodehash = dexRouter.codehash;
        if (currentDexCodehash != dexRouterCodehash) revert DexCodeChanged(dexRouterCodehash, currentDexCodehash);

        uint256[] memory amounts = IPancakeV2Router(dexRouter).getAmountsIn(exactAmountOut, _routes[routeId]);
        if (amounts.length != _routes[routeId].length || amounts[amounts.length - 1] != exactAmountOut) {
            revert InvalidSwapResult();
        }
        amountIn = amounts[0];
        gasEstimate = 0;
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
        uint256[] memory amounts = IPancakeV2Router(dexRouter)
            .swapTokensForExactTokens(exactAmountOut, maxAmountIn, _routes[routeId], msg.sender, deadline);
        input.forceApprove(dexRouter, 0);

        uint256 balanceAfterSwap = input.balanceOf(address(this));
        if (balanceAfterSwap > inputBaseline + maxAmountIn) revert InvalidSwapResult();
        uint256 measuredSpend = inputBaseline + maxAmountIn - balanceAfterSwap;
        if (amounts.length != _routes[routeId].length || amounts[amounts.length - 1] != exactAmountOut) {
            revert InvalidSwapResult();
        }
        amountIn = amounts[0];
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
}
