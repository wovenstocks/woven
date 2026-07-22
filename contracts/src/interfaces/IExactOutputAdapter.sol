// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IExactOutputAdapter
/// @notice Typed interface used by Woven's one-click router. Implementations
///         receive a bounded amount of one immutable input token and return an
///         exact amount of a route-bound output token to the caller.
interface IExactOutputAdapter {
    function inputToken() external view returns (address);

    function routeOutput(bytes32 routeId) external view returns (address);

    function routeHash(bytes32 routeId) external view returns (bytes32);

    function swapExactOutput(
        address tokenOut,
        uint256 exactAmountOut,
        uint256 maxAmountIn,
        uint256 deadline,
        bytes32 routeId
    ) external returns (uint256 amountIn);
}
