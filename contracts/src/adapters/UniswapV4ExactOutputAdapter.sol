// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IExactOutputAdapter} from "../interfaces/IExactOutputAdapter.sol";
import {IExactOutputQuoter} from "../interfaces/IExactOutputQuoter.sol";

interface IAllowanceTransfer {
    function allowance(address owner, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);

    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IUniswapUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IUniswapV4Quoter {
    struct PathKey {
        address intermediateCurrency;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        bytes hookData;
    }

    struct QuoteExactParams {
        address exactCurrency;
        PathKey[] path;
        uint128 exactAmount;
    }

    function quoteExactOutput(QuoteExactParams memory params) external returns (uint256 amountIn, uint256 gasEstimate);
}

/// @title UniswapV4ExactOutputAdapter
/// @notice Immutable, hook-free, route-bound Uniswap v4 exact-output adapter.
/// @dev Execution uses the official Universal Router and Permit2. User supplied
///      calldata cannot alter pool keys, hooks, commands, recipients, or targets.
contract UniswapV4ExactOutputAdapter is IExactOutputAdapter, IExactOutputQuoter, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    struct HopConfig {
        address intermediateCurrency;
        uint24 fee;
        int24 tickSpacing;
    }

    struct RouteConfig {
        bytes32 id;
        address output;
        HopConfig[] path;
    }

    struct PathKey {
        address intermediateCurrency;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        bytes hookData;
    }

    struct ExactOutputParams {
        address currencyOut;
        PathKey[] path;
        uint256[] minHopPriceX36;
        uint128 amountOut;
        uint128 amountInMaximum;
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
    error InvalidTickSpacing(uint256 index);
    error DuplicatePathToken(address token);
    error RouteNotFound(bytes32 routeId);
    error RouteOutputMismatch(address expected, address actual);
    error ZeroAmount();
    error AmountTooLarge();
    error Expired();
    error DeadlineOverflow();
    error DependencyCodeChanged(address dependency, bytes32 expected, bytes32 actual);
    error InexactInputTransfer(uint256 expected, uint256 received);
    error InexactCallerDebit(uint256 expected, uint256 debited);
    error InexactRefund(uint256 expected, uint256 received);
    error InvalidSwapResult();
    error OutputAmountMismatch(uint256 expected, uint256 received);
    error ResidualInput(uint256 expected, uint256 actual);
    error ResidualOutput(uint256 expected, uint256 actual);
    error AllowanceNotCleared(address spender, uint256 remaining);

    uint256 public constant MAX_HOPS = 4;
    bytes1 private constant V4_SWAP_COMMAND = 0x10;
    bytes1 private constant SWAP_EXACT_OUT_ACTION = 0x09;
    bytes1 private constant SETTLE_ALL_ACTION = 0x0c;
    bytes1 private constant TAKE_ALL_ACTION = 0x0f;

    address public immutable override inputToken;
    address public immutable universalRouter;
    address public immutable permit2;
    address public immutable quoter;
    bytes32 public immutable universalRouterCodehash;
    bytes32 public immutable permit2Codehash;
    bytes32 public immutable quoterCodehash;

    mapping(bytes32 routeId => address output) public override routeOutput;
    mapping(bytes32 routeId => bytes32 hash) public override routeHash;
    mapping(bytes32 routeId => HopConfig[] path) private _routes;
    bytes32[] private _routeIds;

    constructor(
        address inputToken_,
        address universalRouter_,
        address permit2_,
        address quoter_,
        RouteConfig[] memory routes_
    ) {
        if (
            inputToken_ == address(0) || universalRouter_ == address(0) || permit2_ == address(0)
                || quoter_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (inputToken_.code.length == 0) revert NotAContract(inputToken_);
        if (universalRouter_.code.length == 0) revert NotAContract(universalRouter_);
        if (permit2_.code.length == 0) revert NotAContract(permit2_);
        if (quoter_.code.length == 0) revert NotAContract(quoter_);
        if (routes_.length == 0) revert NoRoutes();

        inputToken = inputToken_;
        universalRouter = universalRouter_;
        permit2 = permit2_;
        quoter = quoter_;
        universalRouterCodehash = universalRouter_.codehash;
        permit2Codehash = permit2_.codehash;
        quoterCodehash = quoter_.codehash;

        for (uint256 i = 0; i < routes_.length; ++i) {
            RouteConfig memory config = routes_[i];
            if (config.id == bytes32(0)) revert InvalidRouteId();
            if (routeOutput[config.id] != address(0)) revert DuplicateRouteId(config.id);
            if (config.output == address(0) || config.output.code.length == 0) revert InvalidPathEndpoint();

            uint256 length = config.path.length;
            if (length == 0 || length > MAX_HOPS) revert InvalidPathLength(length);
            if (config.path[0].intermediateCurrency != inputToken_ || config.output == inputToken_) {
                revert InvalidPathEndpoint();
            }

            for (uint256 j = 0; j < length; ++j) {
                HopConfig memory hop = config.path[j];
                if (hop.intermediateCurrency == address(0) || hop.intermediateCurrency.code.length == 0) {
                    revert InvalidPathToken(j);
                }
                if (hop.fee == 0) revert InvalidPoolFee(j);
                if (hop.tickSpacing <= 0) revert InvalidTickSpacing(j);
                for (uint256 k = 0; k < j; ++k) {
                    if (config.path[k].intermediateCurrency == hop.intermediateCurrency) {
                        revert DuplicatePathToken(hop.intermediateCurrency);
                    }
                }
                if (hop.intermediateCurrency == config.output) revert DuplicatePathToken(config.output);
                _routes[config.id].push(hop);
            }

            routeOutput[config.id] = config.output;
            routeHash[config.id] = keccak256(abi.encode(config.output, config.path));
            _routeIds.push(config.id);
        }
    }

    function routeIds() external view returns (bytes32[] memory) {
        return _routeIds;
    }

    function route(bytes32 routeId) external view returns (address output, HopConfig[] memory path) {
        output = routeOutput[routeId];
        if (output == address(0)) revert RouteNotFound(routeId);
        path = _routes[routeId];
    }

    function quoteExactOutput(address tokenOut, uint256 exactAmountOut, bytes32 routeId)
        external
        returns (uint256 amountIn, uint256 gasEstimate)
    {
        address configuredOutput = routeOutput[routeId];
        if (configuredOutput == address(0)) revert RouteNotFound(routeId);
        if (configuredOutput != tokenOut) revert RouteOutputMismatch(configuredOutput, tokenOut);
        if (exactAmountOut == 0) revert ZeroAmount();
        if (exactAmountOut > type(uint128).max) revert AmountTooLarge();
        _assertDependencyCode(quoter, quoterCodehash);

        IUniswapV4Quoter.PathKey[] memory path = _quotePathFor(routeId);
        IUniswapV4Quoter.QuoteExactParams memory params = IUniswapV4Quoter.QuoteExactParams({
            exactCurrency: tokenOut, path: path, exactAmount: exactAmountOut.toUint128()
        });
        (amountIn, gasEstimate) = IUniswapV4Quoter(quoter).quoteExactOutput(params);
        if (amountIn == 0) revert InvalidSwapResult();
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
        if (exactAmountOut > type(uint128).max || maxAmountIn > type(uint128).max) revert AmountTooLarge();
        if (block.timestamp > deadline) revert Expired();
        if (deadline > type(uint48).max) revert DeadlineOverflow();

        _assertDependencyCode(universalRouter, universalRouterCodehash);
        _assertDependencyCode(permit2, permit2Codehash);

        IERC20 input = IERC20(inputToken);
        IERC20 output = IERC20(tokenOut);
        uint256 inputBaseline = input.balanceOf(address(this));
        uint256 outputBaseline = output.balanceOf(address(this));
        uint256 callerInputBefore = input.balanceOf(msg.sender);
        uint256 callerOutputBefore = output.balanceOf(msg.sender);

        input.safeTransferFrom(msg.sender, address(this), maxAmountIn);
        uint256 received = input.balanceOf(address(this)) - inputBaseline;
        if (received != maxAmountIn) revert InexactInputTransfer(maxAmountIn, received);
        uint256 callerInputAfter = input.balanceOf(msg.sender);
        uint256 callerDebit =
            callerInputBefore >= callerInputAfter ? callerInputBefore - callerInputAfter : type(uint256).max;
        if (callerDebit != maxAmountIn) revert InexactCallerDebit(maxAmountIn, callerDebit);

        input.forceApprove(permit2, maxAmountIn);
        IAllowanceTransfer(permit2).approve(inputToken, universalRouter, maxAmountIn.toUint160(), deadline.toUint48());

        PathKey[] memory path = _pathFor(routeId);
        uint256[] memory hopPrices = new uint256[](0);
        ExactOutputParams memory swapParams = ExactOutputParams({
            currencyOut: tokenOut,
            path: path,
            minHopPriceX36: hopPrices,
            amountOut: exactAmountOut.toUint128(),
            amountInMaximum: maxAmountIn.toUint128()
        });

        bytes memory actions = abi.encodePacked(SWAP_EXACT_OUT_ACTION, SETTLE_ALL_ACTION, TAKE_ALL_ACTION);
        bytes[] memory actionParams = new bytes[](3);
        actionParams[0] = abi.encode(swapParams);
        actionParams[1] = abi.encode(inputToken, maxAmountIn);
        actionParams[2] = abi.encode(tokenOut, exactAmountOut);

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, actionParams);
        IUniswapUniversalRouter(universalRouter).execute(abi.encodePacked(V4_SWAP_COMMAND), inputs, deadline);

        IAllowanceTransfer(permit2).approve(inputToken, universalRouter, 0, 0);
        input.forceApprove(permit2, 0);

        uint256 inputAfterSwap = input.balanceOf(address(this));
        if (inputAfterSwap > inputBaseline + maxAmountIn) revert InvalidSwapResult();
        amountIn = inputBaseline + maxAmountIn - inputAfterSwap;

        uint256 outputAfterSwap = output.balanceOf(address(this));
        uint256 outputReceived =
            outputAfterSwap >= outputBaseline ? outputAfterSwap - outputBaseline : type(uint256).max;
        if (outputReceived != exactAmountOut) revert OutputAmountMismatch(exactAmountOut, outputReceived);

        output.safeTransfer(msg.sender, exactAmountOut);
        uint256 callerOutputReceived = output.balanceOf(msg.sender) - callerOutputBefore;
        if (callerOutputReceived != exactAmountOut) {
            revert OutputAmountMismatch(exactAmountOut, callerOutputReceived);
        }

        uint256 refund = maxAmountIn - amountIn;
        if (refund > 0) {
            uint256 callerBeforeRefund = input.balanceOf(msg.sender);
            input.safeTransfer(msg.sender, refund);
            uint256 callerAfterRefund = input.balanceOf(msg.sender);
            uint256 refundReceived =
                callerAfterRefund >= callerBeforeRefund ? callerAfterRefund - callerBeforeRefund : type(uint256).max;
            if (refundReceived != refund) revert InexactRefund(refund, refundReceived);
        }

        uint256 finalInputBalance = input.balanceOf(address(this));
        if (finalInputBalance != inputBaseline) revert ResidualInput(inputBaseline, finalInputBalance);
        uint256 finalOutputBalance = output.balanceOf(address(this));
        if (finalOutputBalance != outputBaseline) revert ResidualOutput(outputBaseline, finalOutputBalance);

        // Only the remaining amount controls whether the temporary permission
        // was cleared; Permit2's expiration and nonce are not authorization.
        // slither-disable-next-line unused-return
        (uint160 permitAmount,,) = IAllowanceTransfer(permit2).allowance(address(this), inputToken, universalRouter);
        if (permitAmount != 0) revert AllowanceNotCleared(universalRouter, permitAmount);
        uint256 erc20Allowance = input.allowance(address(this), permit2);
        if (erc20Allowance != 0) revert AllowanceNotCleared(permit2, erc20Allowance);
    }

    function _pathFor(bytes32 routeId) private view returns (PathKey[] memory path) {
        HopConfig[] storage configured = _routes[routeId];
        path = new PathKey[](configured.length);
        for (uint256 i = 0; i < configured.length; ++i) {
            HopConfig storage hop = configured[i];
            path[i] = PathKey({
                intermediateCurrency: hop.intermediateCurrency,
                fee: hop.fee,
                tickSpacing: hop.tickSpacing,
                hooks: address(0),
                hookData: bytes("")
            });
        }
    }

    function _quotePathFor(bytes32 routeId) private view returns (IUniswapV4Quoter.PathKey[] memory path) {
        HopConfig[] storage configured = _routes[routeId];
        path = new IUniswapV4Quoter.PathKey[](configured.length);
        for (uint256 i = 0; i < configured.length; ++i) {
            HopConfig storage hop = configured[i];
            path[i] = IUniswapV4Quoter.PathKey({
                intermediateCurrency: hop.intermediateCurrency,
                fee: hop.fee,
                tickSpacing: hop.tickSpacing,
                hooks: address(0),
                hookData: bytes("")
            });
        }
    }

    function _assertDependencyCode(address dependency, bytes32 expected) private view {
        bytes32 actual = dependency.codehash;
        if (actual != expected) revert DependencyCodeChanged(dependency, expected, actual);
    }
}
