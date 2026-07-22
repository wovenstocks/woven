// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title BasketToken — fully-backed, in-kind mint/redeem basket token
/// @notice An ERC-20 backed by fixed raw quantities of constituent ERC-20s
///         held by this contract. Deposits mint; burns redeem constituents.
/// @dev Adapted for Woven on BNB Smart Chain from Vimen's MIT-licensed
///      BasketToken. The contract deliberately has no oracle, rebalancing,
///      upgradeability, or admin withdrawal path.
contract BasketToken is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error LengthMismatch();
    error InvalidConstituentCount();
    error DuplicateToken();
    error ZeroAddress();
    error NotAContract(address token);
    error ZeroUnits();
    error FeeTooHigh();
    error ZeroSupplyCap();
    error CapExceedsMax();
    error ZeroAmount();
    error MintingPaused();
    error SupplyCapExceeded();
    error ExistingBackingDeficit(address token, uint256 balance, uint256 required);
    error InsufficientDeposit(address token);
    error InvalidRedemptionRecipient();
    error ZeroRedemptionOutput(address token);
    error InexactRedemption(address token, uint256 expected, uint256 basketDecrease, uint256 recipientIncrease);
    error NotGuardian();

    event Minted(address indexed sender, address indexed to, uint256 basketAmount, uint256 fee);
    event Redeemed(address indexed sender, address indexed to, uint256 basketAmount);
    event MintPausedSet(bool paused);
    event SupplyCapSet(uint256 newCap);

    uint256 private constant ONE = 1e18;
    uint256 public constant MAX_FEE_BPS = 50;
    uint256 public constant MIN_CONSTITUENTS = 2;
    uint256 public constant MAX_CONSTITUENTS = 20;

    address public immutable guardian;
    address public immutable feeRecipient;
    uint16 public immutable mintFeeBps;
    uint256 public immutable maxSupplyCap;

    uint256 public supplyCap;
    bool public mintPaused;

    address[] private _tokens;
    uint256[] private _units;

    constructor(
        string memory name_,
        string memory symbol_,
        address[] memory tokens_,
        uint256[] memory unitsPerBasket_,
        uint16 mintFeeBps_,
        address feeRecipient_,
        address guardian_,
        uint256 maxSupplyCap_,
        uint256 initialSupplyCap_
    ) ERC20(name_, symbol_) {
        uint256 n = tokens_.length;
        if (n != unitsPerBasket_.length) revert LengthMismatch();
        if (n < MIN_CONSTITUENTS || n > MAX_CONSTITUENTS) revert InvalidConstituentCount();
        if (mintFeeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeRecipient_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        if (maxSupplyCap_ == 0 || initialSupplyCap_ == 0) revert ZeroSupplyCap();
        if (initialSupplyCap_ > maxSupplyCap_) revert CapExceedsMax();

        for (uint256 i = 0; i < n; ++i) {
            address token = tokens_[i];
            if (token == address(0)) revert ZeroAddress();
            if (token.code.length == 0) revert NotAContract(token);
            if (unitsPerBasket_[i] == 0) revert ZeroUnits();
            for (uint256 j = 0; j < i; ++j) {
                if (tokens_[j] == token) revert DuplicateToken();
            }
        }

        _tokens = tokens_;
        _units = unitsPerBasket_;
        mintFeeBps = mintFeeBps_;
        feeRecipient = feeRecipient_;
        guardian = guardian_;
        maxSupplyCap = maxSupplyCap_;
        supplyCap = initialSupplyCap_;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    /// @notice Deposit every required constituent and mint `basketAmount`.
    function mint(uint256 basketAmount, address to) external nonReentrant {
        if (basketAmount == 0) revert ZeroAmount();
        if (mintPaused) revert MintingPaused();
        uint256 existingSupply = totalSupply();
        if (existingSupply + basketAmount > supplyCap) revert SupplyCapExceeded();

        uint256 n = _tokens.length;
        for (uint256 i = 0; i < n; ++i) {
            IERC20 token = IERC20(_tokens[i]);
            uint256 balanceBefore = token.balanceOf(address(this));
            uint256 existingRequired = Math.mulDiv(existingSupply, _units[i], ONE, Math.Rounding.Ceil);
            if (balanceBefore < existingRequired) {
                revert ExistingBackingDeficit(address(token), balanceBefore, existingRequired);
            }

            uint256 required = Math.mulDiv(basketAmount, _units[i], ONE, Math.Rounding.Ceil);
            token.safeTransferFrom(msg.sender, address(this), required);
            if (token.balanceOf(address(this)) - balanceBefore < required) {
                revert InsufficientDeposit(address(token));
            }
        }

        uint256 fee = (basketAmount * mintFeeBps) / 10_000;
        _mint(to, basketAmount - fee);
        if (fee > 0) _mint(feeRecipient, fee);

        emit Minted(msg.sender, to, basketAmount, fee);
    }

    /// @notice Burn basket tokens and receive every constituent pro rata.
    /// @dev This function is intentionally never gated by pause or guardian.
    function redeem(uint256 basketAmount, address to) external nonReentrant {
        if (basketAmount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        if (to == address(this)) revert InvalidRedemptionRecipient();

        _burn(msg.sender, basketAmount);

        uint256 n = _tokens.length;
        for (uint256 i = 0; i < n; ++i) {
            uint256 amount = Math.mulDiv(basketAmount, _units[i], ONE);
            IERC20 token = IERC20(_tokens[i]);
            if (amount == 0) revert ZeroRedemptionOutput(address(token));
            uint256 basketBalanceBefore = token.balanceOf(address(this));
            uint256 recipientBalanceBefore = token.balanceOf(to);

            token.safeTransfer(to, amount);

            uint256 basketBalanceAfter = token.balanceOf(address(this));
            uint256 recipientBalanceAfter = token.balanceOf(to);
            uint256 basketDecrease =
                basketBalanceAfter <= basketBalanceBefore ? basketBalanceBefore - basketBalanceAfter : 0;
            uint256 recipientIncrease =
                recipientBalanceAfter >= recipientBalanceBefore ? recipientBalanceAfter - recipientBalanceBefore : 0;
            if (basketDecrease != amount || recipientIncrease < amount) {
                revert InexactRedemption(address(token), amount, basketDecrease, recipientIncrease);
            }
        }

        emit Redeemed(msg.sender, to, basketAmount);
    }

    function setMintPaused(bool paused) external onlyGuardian {
        mintPaused = paused;
        emit MintPausedSet(paused);
    }

    function setSupplyCap(uint256 newCap) external onlyGuardian {
        if (newCap > maxSupplyCap) revert CapExceedsMax();
        supplyCap = newCap;
        emit SupplyCapSet(newCap);
    }

    function constituents() external view returns (address[] memory) {
        return _tokens;
    }

    function units() external view returns (uint256[] memory) {
        return _units;
    }

    function getRequiredUnits(uint256 basketAmount)
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        tokens = _tokens;
        amounts = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; ++i) {
            amounts[i] = Math.mulDiv(basketAmount, _units[i], ONE, Math.Rounding.Ceil);
        }
    }

    function backingOf(uint256 basketAmount) external view returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = _tokens;
        amounts = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; ++i) {
            amounts[i] = Math.mulDiv(basketAmount, _units[i], ONE);
        }
    }

    function isFullyBacked() external view returns (bool) {
        uint256 supply = totalSupply();
        uint256 n = _tokens.length;
        for (uint256 i = 0; i < n; ++i) {
            uint256 required = Math.mulDiv(supply, _units[i], ONE, Math.Rounding.Ceil);
            if (IERC20(_tokens[i]).balanceOf(address(this)) < required) return false;
        }
        return true;
    }
}
