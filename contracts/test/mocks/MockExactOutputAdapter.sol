// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IExactOutputAdapter} from "../../src/interfaces/IExactOutputAdapter.sol";

contract FakeBasket {
    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }

    function getRequiredUnits(uint256) external pure returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = new address[](0);
        amounts = new uint256[](0);
    }

    function mint(uint256, address) external pure {}
}

contract MockExactOutputAdapter is IExactOutputAdapter {
    using SafeERC20 for IERC20;

    error ForcedFailure(bytes32 routeId);
    error RouteOutputMismatch(address expected, address actual);

    address public immutable override inputToken;

    mapping(bytes32 routeId => address output) public override routeOutput;
    mapping(bytes32 routeId => bytes32 hash) public override routeHash;
    mapping(bytes32 routeId => uint256 amount) public spend;
    mapping(bytes32 routeId => bool value) public shouldFail;
    mapping(bytes32 routeId => int256 value) public outputDelta;
    mapping(bytes32 routeId => int256 value) public reportDelta;

    address public reentryTarget;
    bytes public reentryCalldata;
    bytes32 public reentryRoute;
    bool public reentryAttempted;
    bool public reentrySucceeded;
    bytes public reentryReturnData;

    constructor(address inputToken_) {
        inputToken = inputToken_;
    }

    function configureRoute(bytes32 routeId, address output, uint256 amountIn) external {
        routeOutput[routeId] = output;
        routeHash[routeId] = keccak256(abi.encode(inputToken, output, routeId));
        spend[routeId] = amountIn;
    }

    function setFailure(bytes32 routeId, bool value) external {
        shouldFail[routeId] = value;
    }

    function setOutputDelta(bytes32 routeId, int256 value) external {
        outputDelta[routeId] = value;
    }

    function setReportDelta(bytes32 routeId, int256 value) external {
        reportDelta[routeId] = value;
    }

    function setSpend(bytes32 routeId, uint256 value) external {
        spend[routeId] = value;
    }

    function setReentry(address target, bytes calldata callData, bytes32 routeId) external {
        reentryTarget = target;
        reentryCalldata = callData;
        reentryRoute = routeId;
    }

    function swapExactOutput(address tokenOut, uint256 exactAmountOut, uint256, uint256, bytes32 routeId)
        external
        returns (uint256 amountIn)
    {
        if (shouldFail[routeId]) revert ForcedFailure(routeId);

        address configuredOutput = routeOutput[routeId];
        if (configuredOutput != tokenOut) revert RouteOutputMismatch(configuredOutput, tokenOut);

        if (reentryTarget != address(0) && reentryRoute == routeId && !reentryAttempted) {
            reentryAttempted = true;
            (bool success, bytes memory returnData) = reentryTarget.call(reentryCalldata);
            reentrySucceeded = success;
            reentryReturnData = returnData;
        }

        uint256 measuredSpend = spend[routeId];
        IERC20(inputToken).safeTransferFrom(msg.sender, address(this), measuredSpend);

        int256 deliveryDelta = outputDelta[routeId];
        uint256 delivered =
            deliveryDelta < 0 ? exactAmountOut - uint256(-deliveryDelta) : exactAmountOut + uint256(deliveryDelta);
        IERC20(tokenOut).safeTransfer(msg.sender, delivered);

        int256 returnedDelta = reportDelta[routeId];
        amountIn = returnedDelta < 0 ? measuredSpend - uint256(-returnedDelta) : measuredSpend + uint256(returnedDelta);
    }
}
