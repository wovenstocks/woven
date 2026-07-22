// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MockERC20} from "./MockERC20.sol";

/// @dev Delivers the requested amount but debits an additional fee from the sender.
contract SenderSurchargeToken is MockERC20 {
    constructor() MockERC20("Sender Surcharge USD", "sUSDC") {}

    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        if (from != address(0) && to != address(0)) {
            super._update(from, address(0), amount / 100);
        }
    }
}

/// @dev Adds a sender-paid surcharge only for a configured account.
contract DirectionalSenderSurchargeToken is MockERC20 {
    address public surchargedSender;

    constructor() MockERC20("Directional Sender Surcharge USD", "dsUSDC") {}

    function setSurchargedSender(address sender) external {
        surchargedSender = sender;
    }

    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        if (from == surchargedSender && to != address(0)) {
            super._update(from, address(0), amount / 100);
        }
    }
}

/// @dev Taxes only transfers sent by a configured address, while debiting exactly `amount`.
contract DirectionalRefundFeeToken is MockERC20 {
    address public taxedSender;

    constructor() MockERC20("Directional Refund Fee USD", "rUSDC") {}

    function setTaxedSender(address sender) external {
        taxedSender = sender;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from == taxedSender && to != address(0)) {
            uint256 fee = amount / 100;
            super._update(from, address(0), fee);
            super._update(from, to, amount - fee);
        } else {
            super._update(from, to, amount);
        }
    }
}
