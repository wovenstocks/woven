// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Deterministic PancakeSwap V2 surface used to verify adapter calldata,
///         accounting, and rollback behavior without relying on a fork.
contract MockPancakeV2Router {
    using SafeERC20 for IERC20;

    error UnexpectedPath(bytes32 expected, bytes32 actual);
    error ExcessiveInputAmount(uint256 amountIn, uint256 maximum);
    error Expired();
    error ForcedFailure();

    bytes32 public expectedPathHash;
    uint256 public quotedAmountIn;
    uint256 public swapAmountIn;
    uint256 public reportedAmountIn;
    int256 public outputDelta;
    bool public failQuote;
    bool public failBeforeTransfers;
    bool public failAfterTransfers;

    bytes32 public lastPathHash;
    address public lastRecipient;
    uint256 public lastAmountOut;
    uint256 public lastAmountInMaximum;
    uint256 public lastDeadline;

    function setExpectedPath(bytes32 pathHash) external {
        expectedPathHash = pathHash;
    }

    function configureQuote(uint256 amountIn) external {
        quotedAmountIn = amountIn;
    }

    function configureSwap(uint256 amountIn, uint256 reportedInput, int256 deliveredOutputDelta) external {
        swapAmountIn = amountIn;
        reportedAmountIn = reportedInput;
        outputDelta = deliveredOutputDelta;
    }

    function setFailures(bool quoteFailure, bool beforeTransfers, bool afterTransfers) external {
        failQuote = quoteFailure;
        failBeforeTransfers = beforeTransfers;
        failAfterTransfers = afterTransfers;
    }

    function getAmountsIn(uint256 amountOut, address[] calldata path) external view returns (uint256[] memory amounts) {
        if (failQuote) revert ForcedFailure();
        _checkPath(path);
        amounts = new uint256[](path.length);
        amounts[0] = quotedAmountIn;
        amounts[path.length - 1] = amountOut;
    }

    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        _checkPath(path);
        if (failBeforeTransfers) revert ForcedFailure();
        if (block.timestamp > deadline) revert Expired();
        if (swapAmountIn > amountInMax) revert ExcessiveInputAmount(swapAmountIn, amountInMax);

        lastPathHash = keccak256(abi.encode(path));
        lastRecipient = to;
        lastAmountOut = amountOut;
        lastAmountInMaximum = amountInMax;
        lastDeadline = deadline;

        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), swapAmountIn);
        IERC20(path[path.length - 1]).safeTransfer(to, _delivered(amountOut));
        if (failAfterTransfers) revert ForcedFailure();

        amounts = new uint256[](path.length);
        amounts[0] = reportedAmountIn;
        amounts[path.length - 1] = amountOut;
    }

    function _checkPath(address[] calldata path) private view {
        bytes32 actual = keccak256(abi.encode(path));
        if (actual != expectedPathHash) revert UnexpectedPath(expectedPathHash, actual);
    }

    function _delivered(uint256 requested) private view returns (uint256) {
        if (outputDelta < 0) return requested - uint256(-outputDelta);
        return requested + uint256(outputDelta);
    }
}

/// @notice Deterministic PancakeSwap V3 SmartRouter exact-output surface.
contract MockPancakeV3Router {
    using SafeERC20 for IERC20;

    struct ExactOutputParams {
        bytes path;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
    }

    error UnexpectedPath(bytes32 expected, bytes32 actual);
    error ExcessiveInputAmount(uint256 amountIn, uint256 maximum);
    error ForcedFailure();

    address public immutable inputToken;
    bytes32 public expectedPathHash;
    uint256 public swapAmountIn;
    uint256 public reportedAmountIn;
    int256 public outputDelta;
    bool public failBeforeTransfers;
    bool public failAfterTransfers;

    bytes32 public lastPathHash;
    address public lastRecipient;
    uint256 public lastAmountOut;
    uint256 public lastAmountInMaximum;

    constructor(address inputToken_) {
        inputToken = inputToken_;
    }

    function setExpectedPath(bytes32 pathHash) external {
        expectedPathHash = pathHash;
    }

    function configureSwap(uint256 amountIn, uint256 reportedInput, int256 deliveredOutputDelta) external {
        swapAmountIn = amountIn;
        reportedAmountIn = reportedInput;
        outputDelta = deliveredOutputDelta;
    }

    function setFailures(bool beforeTransfers, bool afterTransfers) external {
        failBeforeTransfers = beforeTransfers;
        failAfterTransfers = afterTransfers;
    }

    function exactOutput(ExactOutputParams calldata params) external payable returns (uint256 amountIn) {
        bytes32 actualPathHash = keccak256(params.path);
        if (actualPathHash != expectedPathHash) revert UnexpectedPath(expectedPathHash, actualPathHash);
        if (failBeforeTransfers) revert ForcedFailure();
        if (swapAmountIn > params.amountInMaximum) {
            revert ExcessiveInputAmount(swapAmountIn, params.amountInMaximum);
        }

        lastPathHash = actualPathHash;
        lastRecipient = params.recipient;
        lastAmountOut = params.amountOut;
        lastAmountInMaximum = params.amountInMaximum;

        IERC20(inputToken).safeTransferFrom(msg.sender, address(this), swapAmountIn);
        IERC20(_addressAt(params.path, 0)).safeTransfer(params.recipient, _delivered(params.amountOut));
        if (failAfterTransfers) revert ForcedFailure();
        return reportedAmountIn;
    }

    function _addressAt(bytes calldata data, uint256 offset) private pure returns (address result) {
        assembly ("memory-safe") {
            result := shr(96, calldataload(add(data.offset, offset)))
        }
    }

    function _delivered(uint256 requested) private view returns (uint256) {
        if (outputDelta < 0) return requested - uint256(-outputDelta);
        return requested + uint256(outputDelta);
    }
}

/// @notice PancakeSwap QuoterV2-compatible mock that records the exact reverse path.
contract MockPancakeV3Quoter {
    error UnexpectedPath(bytes32 expected, bytes32 actual);
    error ForcedFailure();

    bytes32 public expectedPathHash;
    uint256 public quotedAmountIn;
    uint256 public quotedGas;
    bool public shouldFail;
    bool public malformedResponse;

    bytes32 public lastPathHash;
    uint256 public lastAmountOut;

    function setExpectedPath(bytes32 pathHash) external {
        expectedPathHash = pathHash;
    }

    function configureQuote(uint256 amountIn, uint256 gasEstimate) external {
        quotedAmountIn = amountIn;
        quotedGas = gasEstimate;
    }

    function setFailure(bool value) external {
        shouldFail = value;
    }

    function setMalformedResponse(bool value) external {
        malformedResponse = value;
    }

    function quoteExactOutput(bytes memory path, uint256 amountOut)
        external
        returns (
            uint256 amountIn,
            uint160[] memory sqrtPriceX96AfterList,
            uint32[] memory initializedTicksCrossedList,
            uint256 gasEstimate
        )
    {
        if (shouldFail) revert ForcedFailure();
        bytes32 actualPathHash = keccak256(path);
        if (actualPathHash != expectedPathHash) revert UnexpectedPath(expectedPathHash, actualPathHash);

        lastPathHash = actualPathHash;
        lastAmountOut = amountOut;
        uint256 hops = malformedResponse ? 0 : (path.length - 20) / 23;
        sqrtPriceX96AfterList = new uint160[](hops);
        initializedTicksCrossedList = new uint32[](hops);
        for (uint256 i = 0; i < hops; ++i) {
            sqrtPriceX96AfterList[i] = 1;
        }
        return (quotedAmountIn, sqrtPriceX96AfterList, initializedTicksCrossedList, quotedGas);
    }
}
