// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockPermit2 {
    using SafeERC20 for IERC20;

    struct PackedAllowance {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    error AllowanceExpired(uint48 expiration);
    error InsufficientAllowance(uint160 available, uint160 required);

    mapping(address owner => mapping(address token => mapping(address spender => PackedAllowance value))) private
        _allowances;

    bool public ignoreClear;

    function setIgnoreClear(bool value) external {
        ignoreClear = value;
    }

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        if (ignoreClear && amount == 0) return;
        PackedAllowance storage permitted = _allowances[msg.sender][token][spender];
        permitted.amount = amount;
        permitted.expiration = expiration;
    }

    function allowance(address owner, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce)
    {
        PackedAllowance storage permitted = _allowances[owner][token][spender];
        return (permitted.amount, permitted.expiration, permitted.nonce);
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        PackedAllowance storage permitted = _allowances[from][token][msg.sender];
        if (block.timestamp > permitted.expiration) revert AllowanceExpired(permitted.expiration);
        if (amount > permitted.amount) revert InsufficientAllowance(permitted.amount, amount);
        permitted.amount -= amount;
        IERC20(token).safeTransferFrom(from, to, amount);
    }
}

contract MockV4Quoter {
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

    struct StoredPathKey {
        address intermediateCurrency;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        bytes32 hookDataHash;
        uint256 hookDataLength;
    }

    error ForcedQuoteFailure();

    uint256 public configuredAmountIn;
    uint256 public configuredGasEstimate;
    bool public shouldFail;

    address public lastExactCurrency;
    uint128 public lastExactAmount;
    StoredPathKey[] private _lastPath;

    function setQuote(uint256 amountIn, uint256 gasEstimate) external {
        configuredAmountIn = amountIn;
        configuredGasEstimate = gasEstimate;
    }

    function setFailure(bool value) external {
        shouldFail = value;
    }

    function quoteExactOutput(QuoteExactParams memory params) external returns (uint256 amountIn, uint256 gasEstimate) {
        if (shouldFail) revert ForcedQuoteFailure();
        lastExactCurrency = params.exactCurrency;
        lastExactAmount = params.exactAmount;
        delete _lastPath;
        for (uint256 i = 0; i < params.path.length; ++i) {
            PathKey memory key = params.path[i];
            _lastPath.push(
                StoredPathKey({
                    intermediateCurrency: key.intermediateCurrency,
                    fee: key.fee,
                    tickSpacing: key.tickSpacing,
                    hooks: key.hooks,
                    hookDataHash: keccak256(key.hookData),
                    hookDataLength: key.hookData.length
                })
            );
        }
        return (configuredAmountIn, configuredGasEstimate);
    }

    function lastPathLength() external view returns (uint256) {
        return _lastPath.length;
    }

    function lastPath(uint256 index) external view returns (StoredPathKey memory) {
        return _lastPath[index];
    }
}

contract MockUniversalRouter {
    using SafeERC20 for IERC20;

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

    struct StoredPathKey {
        address intermediateCurrency;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        bytes32 hookDataHash;
        uint256 hookDataLength;
    }

    error ForcedRouterFailure();
    error InvalidCommands(bytes commands);
    error InvalidActions(bytes actions);
    error InvalidInputCount(uint256 count);
    error Expired();

    MockPermit2 public immutable permit2;

    uint256 public configuredAmountIn;
    int256 public configuredOutputDelta;
    bool public shouldFail;

    bytes public lastCommands;
    bytes public lastActions;
    uint256 public lastDeadline;
    address public lastCaller;
    address public lastCurrencyOut;
    uint128 public lastAmountOut;
    uint128 public lastAmountInMaximum;
    uint256 public lastMinHopPriceLength;
    address public lastSettleCurrency;
    uint256 public lastSettleMaximum;
    address public lastTakeCurrency;
    uint256 public lastTakeMinimum;
    StoredPathKey[] private _lastPath;

    address public reentryTarget;
    bytes public reentryCalldata;
    bool public reentryAttempted;
    bool public reentrySucceeded;
    bytes public reentryReturnData;

    constructor(MockPermit2 permit2_) {
        permit2 = permit2_;
    }

    function configureSwap(uint256 amountIn, int256 outputDelta) external {
        configuredAmountIn = amountIn;
        configuredOutputDelta = outputDelta;
    }

    function setFailure(bool value) external {
        shouldFail = value;
    }

    function setReentry(address target, bytes calldata callData) external {
        reentryTarget = target;
        reentryCalldata = callData;
    }

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable {
        if (shouldFail) revert ForcedRouterFailure();
        if (block.timestamp > deadline) revert Expired();
        if (keccak256(commands) != keccak256(hex"10")) revert InvalidCommands(commands);
        if (inputs.length != 1) revert InvalidInputCount(inputs.length);

        lastCommands = commands;
        lastDeadline = deadline;
        lastCaller = msg.sender;

        (bytes memory actions, bytes[] memory actionParams) = abi.decode(inputs[0], (bytes, bytes[]));
        if (keccak256(actions) != keccak256(hex"090c0f")) revert InvalidActions(actions);
        if (actionParams.length != 3) revert InvalidInputCount(actionParams.length);
        lastActions = actions;

        ExactOutputParams memory swapParams = abi.decode(actionParams[0], (ExactOutputParams));
        lastCurrencyOut = swapParams.currencyOut;
        lastAmountOut = swapParams.amountOut;
        lastAmountInMaximum = swapParams.amountInMaximum;
        lastMinHopPriceLength = swapParams.minHopPriceX36.length;

        delete _lastPath;
        for (uint256 i = 0; i < swapParams.path.length; ++i) {
            PathKey memory key = swapParams.path[i];
            _lastPath.push(
                StoredPathKey({
                    intermediateCurrency: key.intermediateCurrency,
                    fee: key.fee,
                    tickSpacing: key.tickSpacing,
                    hooks: key.hooks,
                    hookDataHash: keccak256(key.hookData),
                    hookDataLength: key.hookData.length
                })
            );
        }

        (lastSettleCurrency, lastSettleMaximum) = abi.decode(actionParams[1], (address, uint256));
        (lastTakeCurrency, lastTakeMinimum) = abi.decode(actionParams[2], (address, uint256));

        if (reentryTarget != address(0) && !reentryAttempted) {
            reentryAttempted = true;
            (reentrySucceeded, reentryReturnData) = reentryTarget.call(reentryCalldata);
        }

        permit2.transferFrom(msg.sender, address(this), uint160(configuredAmountIn), lastSettleCurrency);

        uint256 delivered = configuredOutputDelta < 0
            ? uint256(swapParams.amountOut) - uint256(-configuredOutputDelta)
            : uint256(swapParams.amountOut) + uint256(configuredOutputDelta);
        IERC20(swapParams.currencyOut).safeTransfer(msg.sender, delivered);
    }

    function lastPathLength() external view returns (uint256) {
        return _lastPath.length;
    }

    function lastPath(uint256 index) external view returns (StoredPathKey memory) {
        return _lastPath[index];
    }
}
