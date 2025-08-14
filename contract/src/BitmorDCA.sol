// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function getReserveData(address asset) external view returns (
        uint256 liquidityIndex,
        uint256 currentLiquidityRate,
        uint256 variableBorrowIndex,
        uint256 currentVariableBorrowRate,
        uint256 currentStableBorrowRate,
        uint40 lastUpdateTimestamp,
        address aTokenAddress,
        address stableDebtTokenAddress,
        address variableDebtTokenAddress,
        uint128 borrowingEnabled,
        uint128 isActive,
        uint128 isFrozen
    );
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
}

contract BitmorDCA is ReentrancyGuard, Pausable, Ownable {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    // Constants
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant DAILY_GRACE_PERIOD = 7 days;
    uint256 public constant WEEKLY_GRACE_PERIOD = 21 days;
    uint256 public constant MIN_PENALTY = 100; // 1%
    uint256 public constant MAX_PENALTY = 5000; // 50%
    uint256 public constant PENALTY_EXPONENT = 15; // 1.5 in fixed point (x10)
    
    // External contracts
    IERC20 public immutable usdc;
    IERC20 public immutable wbtc;
    IAavePool public immutable aavePool;
    IUniswapV2Router public immutable uniswapRouter;
    
    // Backend signer for off-chain calculations
    address public backendSigner;
    
    // Enums
    enum PlanStatus { INACTIVE, ACTIVE, PAUSED, COMPLETED, EARLY_EXIT }
    enum Cadence { DAILY, WEEKLY }
    
    // Core user state
    struct UserPlan {
        uint128 totalPaid;           // Total USDC paid
        uint128 btcAccumulated;      // BTC accumulated
        uint128 targetBTC;           // Target BTC amount
        uint64 startTime;            // Plan start timestamp
        uint64 lastPaymentTime;      // Last payment timestamp
        uint32 streak;               // Current streak count
        uint32 maxStreak;           // Maximum streak achieved
        uint32 prepaidDays;         // Days prepaid
        uint32 withdrawalDelay;     // Withdrawal delay in days
        uint32 timePeriod;          // Total plan duration in days
        Cadence cadence;            // Payment cadence
        PlanStatus status;          // Current plan status
        bool bitmorEnabled;         // Bitmor integration flag
        bool thresholdReached;      // Bitmor threshold reached flag
    }
    
    // Rewards and dust
    struct UserExtras {
        uint128 rewardBalance;       // Accumulated rewards
        uint128 dustBalance;         // Dust balance for sweeping
        uint128 yieldBoost;         // Hidden yield boost
        uint64 lastRewardClaim;     // Last reward claim timestamp
        uint32 rewardWeight;        // Reward weight based on streak
    }
    
    // Strategy template
    struct Strategy {
        uint128 targetBTC;          // Target BTC amount
        uint128 dailyAmount;        // Daily USDC amount
        uint32 timePeriod;         // Duration in days
        uint32 withdrawalDelay;    // Withdrawal delay in days
        uint16 penaltyMin;        // Min penalty in basis points
        uint16 penaltyMax;        // Max penalty in basis points
        uint16 fee;               // Fee in basis points
        Cadence cadence;          // Payment cadence
        address creator;          // Strategy creator
        bool isActive;           // Strategy status
    }
    
    // State variables
    mapping(address => UserPlan) public users;
    mapping(address => UserExtras) public userExtras;
    mapping(uint256 => Strategy) public strategies;
    mapping(address => uint256) public userStrategyId; // 0 = custom plan
    mapping(bytes32 => bool) public usedNonces;
    
    uint256 public totalStrategies;
    uint256 public totalValueLocked;
    uint256 public rewardsPool;
    uint256 public yieldPool;
    uint256 public dustThreshold = 10 * 10**6; // $10 USDC
    
    // Events
    event PlanCreated(
        address indexed user,
        uint128 targetBTC,
        uint128 dailyAmount,
        uint32 timePeriod,
        Cadence cadence,
        bool bitmorEnabled
    );
    event PaymentProcessed(
        address indexed user,
        uint128 usdcAmount,
        uint128 btcAmount,
        uint32 streak,
        bool usesPrepaid
    );
    event StrategyCreated(
        uint256 indexed strategyId,
        address indexed creator,
        uint128 targetBTC,
        Cadence cadence
    );
    event EarlyWithdrawal(
        address indexed user,
        uint128 btcAmount,
        uint128 penalty,
        uint32 daysRemaining
    );
    event BitmorThresholdReached(
        address indexed user,
        uint128 btcAmount,
        uint128 loanAmount
    );
    event RewardsDistributed(
        address indexed user,
        uint128 rewardAmount,
        uint128 yieldBoost
    );
    event DustSwept(
        address indexed user,
        uint128 dustAmount,
        uint128 btcAmount
    );
    
    constructor(
        address _usdc,
        address _wbtc,
        address _aavePool,
        address _uniswapRouter,
        address _backendSigner
    ) Ownable() {
        usdc = IERC20(_usdc);
        wbtc = IERC20(_wbtc);
        aavePool = IAavePool(_aavePool);
        uniswapRouter = IUniswapV2Router(_uniswapRouter);
        backendSigner = _backendSigner;
    }
    
    // Create DCA plan
    function createDCAplan(
        uint128 _targetBTC,
        uint128 _dailyAmount,
        uint32 _timePeriod,
        uint32 _withdrawalDelay,
        Cadence _cadence,
        bool _bitmorEnabled,
        bytes32 _nonce,
        bytes memory _signature
    ) external nonReentrant whenNotPaused {
        require(users[msg.sender].status == PlanStatus.INACTIVE || 
                users[msg.sender].status == PlanStatus.COMPLETED, "Active plan exists");
        require(_timePeriod > 0 && _withdrawalDelay > 0, "Invalid periods");
        require(!usedNonces[_nonce], "Nonce used");
        
        // Verify backend signature
        bytes32 messageHash = keccak256(abi.encodePacked(
            msg.sender,
            _targetBTC,
            _dailyAmount,
            _timePeriod,
            _withdrawalDelay,
            _cadence,
            _bitmorEnabled,
            _nonce,
            block.chainid
        ));
        require(_verifySignature(messageHash, _signature), "Invalid signature");
        
        usedNonces[_nonce] = true;
        
        users[msg.sender] = UserPlan({
            totalPaid: 0,
            btcAccumulated: 0,
            targetBTC: _targetBTC,
            startTime: uint64(block.timestamp),
            lastPaymentTime: 0,
            streak: 0,
            maxStreak: 0,
            prepaidDays: 0,
            withdrawalDelay: _withdrawalDelay,
            timePeriod: _timePeriod,
            cadence: _cadence,
            status: PlanStatus.ACTIVE,
            bitmorEnabled: _bitmorEnabled,
            thresholdReached: false
        });
        
        userStrategyId[msg.sender] = 0; // Custom plan
        
        emit PlanCreated(
            msg.sender,
            _targetBTC,
            _dailyAmount,
            _timePeriod,
            _cadence,
            _bitmorEnabled
        );
    }
    
    // Make payment
    function makePayment(
        uint128 _usdcAmount,
        uint128 _btcAmount,
        bool _usesPrepaid,
        bytes32 _nonce,
        bytes memory _signature
    ) external nonReentrant whenNotPaused {
        UserPlan storage user = users[msg.sender];
        require(user.status == PlanStatus.ACTIVE, "Plan not active");
        require(!usedNonces[_nonce], "Nonce used");
        require(usdc.balanceOf(msg.sender) >= _usdcAmount, "Insufficient USDC");
        
        // Verify backend calculation
        bytes32 messageHash = keccak256(abi.encodePacked(
            msg.sender,
            _usdcAmount,
            _btcAmount,
            _usesPrepaid,
            _nonce,
            block.chainid
        ));
        require(_verifySignature(messageHash, _signature), "Invalid signature");
        
        usedNonces[_nonce] = true;
        
        // Handle prepaid logic and streak
        if (_usesPrepaid && user.prepaidDays > 0) {
            user.prepaidDays--;
        } else {
            // Check if payment is on time
            uint256 gracePeriod = user.cadence == Cadence.DAILY ? 
                DAILY_GRACE_PERIOD : WEEKLY_GRACE_PERIOD;
            
            if (user.lastPaymentTime == 0 || 
                block.timestamp <= user.lastPaymentTime + gracePeriod) {
                user.streak++;
                if (user.streak > user.maxStreak) {
                    user.maxStreak = user.streak;
                }
            } else {
                user.streak = 1; // Reset streak but count this payment
            }
        }
        
        // Transfer USDC and deposit to Aave
        usdc.safeTransferFrom(msg.sender, address(this), _usdcAmount);
        usdc.safeIncreaseAllowance(address(aavePool), _usdcAmount);
        aavePool.supply(address(usdc), _usdcAmount, address(this), 0);
        
        // Update state
        user.totalPaid += _usdcAmount;
        user.btcAccumulated += _btcAmount;
        user.lastPaymentTime = uint64(block.timestamp);
        totalValueLocked += _usdcAmount;
        
        // Check if target reached
        if (user.btcAccumulated >= user.targetBTC) {
            user.status = PlanStatus.COMPLETED;
        }
        
        emit PaymentProcessed(
            msg.sender,
            _usdcAmount,
            _btcAmount,
            user.streak,
            _usesPrepaid
        );
    }
    
    // Prepay days
    function prepayDays(
        uint128 _usdcAmount,
        uint32 _days,
        bytes32 _nonce,
        bytes memory _signature
    ) external nonReentrant whenNotPaused {
        UserPlan storage user = users[msg.sender];
        require(user.status == PlanStatus.ACTIVE, "Plan not active");
        require(!usedNonces[_nonce], "Nonce used");
        require(usdc.balanceOf(msg.sender) >= _usdcAmount, "Insufficient USDC");
        
        // Verify backend calculation
        bytes32 messageHash = keccak256(abi.encodePacked(
            msg.sender,
            _usdcAmount,
            _days,
            _nonce,
            block.chainid
        ));
        require(_verifySignature(messageHash, _signature), "Invalid signature");
        
        usedNonces[_nonce] = true;
        
        // Transfer and deposit
        usdc.safeTransferFrom(msg.sender, address(this), _usdcAmount);
        usdc.safeIncreaseAllowance(address(aavePool), _usdcAmount);
        aavePool.supply(address(usdc), _usdcAmount, address(this), 0);
        
        user.prepaidDays += _days;
        totalValueLocked += _usdcAmount;
    }
    
    // Early withdrawal
    function earlyWithdraw(
        uint128 _btcAmount,
        uint128 _penaltyAmount,
        uint32 _daysRemaining,
        bytes32 _nonce,
        bytes memory _signature
    ) external nonReentrant whenNotPaused {
        UserPlan storage user = users[msg.sender];
        require(user.status == PlanStatus.ACTIVE, "Plan not active");
        require(user.btcAccumulated > 0, "No BTC to withdraw");
        require(!usedNonces[_nonce], "Nonce used");
        require(block.timestamp >= user.startTime + user.withdrawalDelay * 1 days, "Withdrawal delay active");
        
        // Verify backend calculation
        bytes32 messageHash = keccak256(abi.encodePacked(
            msg.sender,
            _btcAmount,
            _penaltyAmount,
            _daysRemaining,
            _nonce,
            block.chainid
        ));
        require(_verifySignature(messageHash, _signature), "Invalid signature");
        
        usedNonces[_nonce] = true;
        
        uint128 withdrawAmount = _btcAmount - _penaltyAmount;
        
        // Add penalty to rewards pool
        rewardsPool += _penaltyAmount;
        
        // Update state
        user.status = PlanStatus.EARLY_EXIT;
        user.btcAccumulated = 0;
        
        // Withdraw proportional USDC from Aave
        _withdrawFromAave(user.totalPaid);
        
        // Transfer BTC
        wbtc.safeTransfer(msg.sender, withdrawAmount);
        
        emit EarlyWithdrawal(
            msg.sender,
            withdrawAmount,
            _penaltyAmount,
            _daysRemaining
        );
    }
    
    // Complete plan
    function completePlan(
        bytes32 _nonce,
        bytes memory _signature
    ) external nonReentrant whenNotPaused {
        UserPlan storage user = users[msg.sender];
        require(user.status == PlanStatus.ACTIVE, "Plan not active");
        require(user.btcAccumulated >= user.targetBTC, "Target not reached");
        require(!usedNonces[_nonce], "Nonce used");
        
        // Verify backend completion verification
        bytes32 messageHash = keccak256(abi.encodePacked(
            msg.sender,
            "COMPLETE",
            _nonce,
            block.chainid
        ));
        require(_verifySignature(messageHash, _signature), "Invalid signature");
        
        usedNonces[_nonce] = true;
        
        uint128 btcAmount = user.btcAccumulated;
        user.status = PlanStatus.COMPLETED;
        user.btcAccumulated = 0;
        
        // Withdraw from Aave
        _withdrawFromAave(user.totalPaid);
        
        // Transfer BTC
        wbtc.safeTransfer(msg.sender, btcAmount);
    }
    
    // Distribute rewards
    function distributeRewards(
        address[] calldata _users,
        uint128[] calldata _amounts,
        uint128[] calldata _boosts,
        bytes32 _nonce,
        bytes memory _signature
    ) external whenNotPaused {
        require(_users.length == _amounts.length && _amounts.length == _boosts.length, "Array length mismatch");
        require(!usedNonces[_nonce], "Nonce used");
        
        // Verify backend reward calculation
        bytes32 messageHash = keccak256(abi.encodePacked(
            _users,
            _amounts,
            _boosts,
            _nonce,
            block.chainid
        ));
        require(_verifySignature(messageHash, _signature), "Invalid signature");
        
        usedNonces[_nonce] = true;
        
        for (uint i = 0; i < _users.length; i++) {
            UserExtras storage extras = userExtras[_users[i]];
            if (_amounts[i] > 0 && _amounts[i] <= rewardsPool) {
                extras.rewardBalance += _amounts[i];
                extras.yieldBoost += _boosts[i];
                rewardsPool -= _amounts[i];
                emit RewardsDistributed(_users[i], _amounts[i], _boosts[i]);
            }
        }
    }
    
    // Claim rewards
    function claimRewards() external nonReentrant whenNotPaused {
        UserExtras storage extras = userExtras[msg.sender];
        uint128 rewardAmount = extras.rewardBalance;
        uint128 boostAmount = extras.yieldBoost;
        require(rewardAmount > 0 || boostAmount > 0, "No rewards to claim");
        
        extras.rewardBalance = 0;
        extras.yieldBoost = 0;
        extras.lastRewardClaim = uint64(block.timestamp);
        
        uint128 totalAmount = rewardAmount + boostAmount;
        wbtc.safeTransfer(msg.sender, totalAmount);
    }
    
    // Sweep dust
    function sweepDust(
        uint128[] calldata _tokenAmounts,
        address[] calldata _tokens,
        uint128 _expectedBTC,
        bytes32 _nonce,
        bytes memory _signature
    ) external nonReentrant whenNotPaused {
        require(_tokenAmounts.length == _tokens.length, "Array length mismatch");
        require(!usedNonces[_nonce], "Nonce used");
        
        // Verify backend dust calculation
        bytes32 messageHash = keccak256(abi.encodePacked(
            msg.sender,
            _tokenAmounts,
            _tokens,
            _expectedBTC,
            _nonce,
            block.chainid
        ));
        require(_verifySignature(messageHash, _signature), "Invalid signature");
        
        usedNonces[_nonce] = true;
        
        uint128 totalDustValue = 0;
        
        // Transfer dust tokens
        for (uint i = 0; i < _tokens.length; i++) {
            if (_tokenAmounts[i] > 0) {
                IERC20(_tokens[i]).safeTransferFrom(msg.sender, address(this), _tokenAmounts[i]);
                totalDustValue += _tokenAmounts[i];
            }
        }
        
        require(totalDustValue >= dustThreshold, "Dust below threshold");
        
        // Swap dust to BTC via Uniswap
        for (uint i = 0; i < _tokens.length; i++) {
            if (_tokenAmounts[i] > 0) {
                IERC20(_tokens[i]).safeIncreaseAllowance(address(uniswapRouter), _tokenAmounts[i]);
                
                address[] memory path = new address[](2);
                path[0] = _tokens[i];
                path[1] = address(wbtc);
                
                uniswapRouter.swapExactTokensForTokens(
                    _tokenAmounts[i],
                    0, // Accept any amount of BTC
                    path,
                    address(this),
                    block.timestamp + 1800 // 30 minute deadline
                );
            }
        }
        
        // Verify received BTC amount
        uint128 receivedBTC = uint128(wbtc.balanceOf(address(this)));
        require(receivedBTC >= _expectedBTC, "Insufficient BTC from swap");
        
        // Add to user's BTC balance
        UserPlan storage user = users[msg.sender];
        require(user.status == PlanStatus.ACTIVE, "Plan not active");
        user.btcAccumulated += receivedBTC;
        
        emit DustSwept(msg.sender, totalDustValue, receivedBTC);
    }
    
    // Internal functions
    function _withdrawFromAave(uint128 _usdcAmount) internal {
        if (_usdcAmount > 0) {
            aavePool.withdraw(address(usdc), _usdcAmount, address(this));
        }
    }
    
    function _verifySignature(bytes32 _messageHash, bytes memory _signature) internal view returns (bool) {
        bytes32 ethSignedMessageHash = _messageHash.toEthSignedMessageHash();
        return ethSignedMessageHash.recover(_signature) == backendSigner;
    }
    
    // View functions
    function getUserPlan(address _user) external view returns (UserPlan memory) {
        return users[_user];
    }
    
    function getUserExtras(address _user) external view returns (UserExtras memory) {
        return userExtras[_user];
    }
    
    function getStrategy(uint256 _strategyId) external view returns (Strategy memory) {
        return strategies[_strategyId];
    }
    
    function getAaveYield() external view returns (uint256) {
        (, uint256 currentLiquidityRate,,,,,,,,,,) = aavePool.getReserveData(address(usdc));
        return currentLiquidityRate;
    }
    
    // Admin functions
    function setBackendSigner(address _newSigner) external onlyOwner {
        backendSigner = _newSigner;
    }
    
    function setDustThreshold(uint256 _newThreshold) external onlyOwner {
        dustThreshold = _newThreshold;
    }
    
    function depositWBTCReserves(uint256 _amount) external onlyOwner {
        wbtc.safeTransferFrom(msg.sender, address(this), _amount);
    }
    
    function emergencyWithdraw() external onlyOwner {
        // Withdraw all from Aave
        aavePool.withdraw(address(usdc), type(uint256).max, owner());
        
        // Transfer remaining balances
        uint256 usdcBalance = usdc.balanceOf(address(this));
        uint256 btcBalance = wbtc.balanceOf(address(this));
        
        if (usdcBalance > 0) usdc.safeTransfer(owner(), usdcBalance);
        if (btcBalance > 0) wbtc.safeTransfer(owner(), btcBalance);
    }
    
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}