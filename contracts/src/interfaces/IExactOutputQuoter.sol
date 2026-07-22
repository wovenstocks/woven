// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IExactOutputQuoter
/// @notice Uniform offchain-eth_call quote surface for Woven's typed adapters.
/// @dev Implementations may be non-view because concentrated-liquidity quoters
///      obtain results through simulated swaps and controlled reverts.
interface IExactOutputQuoter {
    function quoteExactOutput(address tokenOut, uint256 exactAmountOut, bytes32 routeId)
        external
        returns (uint256 amountIn, uint256 gasEstimate);
}
