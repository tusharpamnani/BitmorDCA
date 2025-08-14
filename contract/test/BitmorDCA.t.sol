// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../src/BitmorDCA.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IAavePoolMock {
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

interface IUniswapV2RouterMock {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
}

contract MockToken is IERC20 {
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;
    uint256 private _totalSupply;
    string private _name;
    string private _symbol;
    uint8 private _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        _name = name_;
        _symbol = symbol_;
        _decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        _balances[to] += amount;
        _totalSupply += amount;
    }

    function name() external view returns (string memory) { return _name; }
    function symbol() external view returns (string memory) { return _symbol; }
    function decimals() external view returns (uint8) { return _decimals; }
    function totalSupply() external view override returns (uint256) { return _totalSupply; }
    function balanceOf(address account) external view override returns (uint256) { return _balances[account]; }
    
    function transfer(address to, uint256 amount) external override returns (bool) {
        require(_balances[msg.sender] >= amount, "Insufficient balance");
        _balances[msg.sender] -= amount;
        _balances[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
    
    function allowance(address owner, address spender) external view override returns (uint256) {
        return _allowances[owner][spender];
    }
    
    function approve(address spender, uint256 amount) external override returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
    
    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        require(_balances[from] >= amount, "Insufficient balance");
        require(_allowances[from][msg.sender] >= amount, "Insufficient allowance");
        _balances[from] -= amount;
        _balances[to] += amount;
        _allowances[from][msg.sender] -= amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

contract MockAavePool is IAavePoolMock {
    mapping(address => uint256) public deposits;
    uint256 public constant YIELD_RATE = 500; // 5% APY in basis points

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external override {
        deposits[onBehalfOf] += amount;
        IERC20(asset).transferFrom(msg.sender, address(this), amount);
    }

    function withdraw(address asset, uint256 amount, address to) external override returns (uint256) {
        require(deposits[msg.sender] >= amount, "Insufficient deposit");
        deposits[msg.sender] -= amount;
        IERC20(asset).transfer(to, amount);
        return amount;
    }

    function getReserveData(address) external pure override returns (
        uint256, uint256, uint256, uint256, uint256, uint40,
        address, address, address, uint128, uint128, uint128
    ) {
        return (0, YIELD_RATE, 0, 0, 0, 0, address(0), address(0), address(0), 1, 1, 0);
    }
}

contract MockUniswapRouter is IUniswapV2RouterMock {
    // Mock exchange rate: 1 WBTC = 20,000 USDC
    uint256 public constant EXCHANGE_RATE = 20000;

    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external override returns (uint[] memory amounts) {
        require(deadline >= block.timestamp, "Expired");
        require(path.length == 2, "Invalid path");

        // Calculate WBTC amount (simplified)
        uint256 wbtcAmount = (amountIn * 1e8) / (EXCHANGE_RATE * 1e6); // Convert from USDC to WBTC
        require(wbtcAmount >= amountOutMin, "Insufficient output");

        // Transfer tokens
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        IERC20(path[1]).transfer(to, wbtcAmount);

        amounts = new uint[](2);
        amounts[0] = amountIn;
        amounts[1] = wbtcAmount;
        return amounts;
    }
}

contract BitmorDCATest is Test {
    BitmorDCA public dca;
    MockToken public usdc;
    MockToken public cbBTC;
    MockAavePool public aavePool;
    MockUniswapRouter public uniswapRouter;
    
    address public owner;
    address public user1;
    address public user2;
    address public backendSigner;
    uint256 public backendSignerKey;

    // Events to test
    event PlanCreated(
        address indexed user,
        uint128 targetBTC,
        uint128 dailyAmount,
        uint32 timePeriod,
        BitmorDCA.Cadence cadence,
        bool bitmorEnabled
    );

    event PaymentProcessed(
        address indexed user,
        uint128 usdcAmount,
        uint128 btcAmount,
        uint32 streak,
        bool usesPrepaid
    );

    function setUp() public {
        // Setup accounts
        owner = makeAddr("owner");
        user1 = makeAddr("user1");
        user2 = makeAddr("user2");
        backendSignerKey = 0x123; // Example private key
        backendSigner = vm.addr(backendSignerKey);

        vm.startPrank(owner);

        // Deploy mock tokens
        usdc = new MockToken("USD Coin", "USDC", 6);
        cbBTC = new MockToken("Coinbase Wrapped Bitcoin", "cbBTC", 8);
        aavePool = new MockAavePool();
        uniswapRouter = new MockUniswapRouter();

        // Deploy DCA contract
        dca = new BitmorDCA(
            address(usdc),
            address(cbBTC),
            address(aavePool),
            address(uniswapRouter),
            backendSigner
        );

        vm.stopPrank();

        // Setup initial token balances
        _setupTokenBalances();
    }

    function testCreateDCAPlan() public {
        vm.startPrank(user1);

        // Plan parameters
        uint128 targetBTC = 1e8; // 1 BTC
        uint128 dailyAmount = 100 * 1e6; // 100 USDC
        uint32 timePeriod = 365; // 1 year
        uint32 withdrawalDelay = 30; // 30 days
        BitmorDCA.Cadence cadence = BitmorDCA.Cadence.DAILY;
        bool bitmorEnabled = true;
        bytes32 nonce = bytes32(uint256(1));

        // Create signature
        bytes32 messageHash = keccak256(abi.encodePacked(
            user1,
            targetBTC,
            dailyAmount,
            timePeriod,
            withdrawalDelay,
            cadence,
            bitmorEnabled,
            nonce,
            block.chainid
        ));
        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(backendSignerKey, ethSignedMessageHash);
        bytes memory signature = abi.encodePacked(r, s, v);

        // Expect event
        vm.expectEmit(true, true, true, true);
        emit PlanCreated(user1, targetBTC, dailyAmount, timePeriod, cadence, bitmorEnabled);

        // Create plan
        dca.createDCAplan(
            targetBTC,
            dailyAmount,
            timePeriod,
            withdrawalDelay,
            cadence,
            bitmorEnabled,
            nonce,
            signature
        );

        // Verify plan creation
        BitmorDCA.UserPlan memory plan = dca.getUserPlan(user1);
        assertEq(plan.targetBTC, targetBTC);
        assertEq(uint8(plan.status), uint8(BitmorDCA.PlanStatus.ACTIVE));
        assertEq(plan.bitmorEnabled, bitmorEnabled);
        assertEq(plan.timePeriod, timePeriod);

        vm.stopPrank();
    }

    function testMakePayment() public {
        // First create a plan
        testCreateDCAPlan();

        vm.startPrank(user1);

        // Payment parameters
        uint128 usdcAmount = 100 * 1e6; // 100 USDC
        uint128 btcAmount = 5 * 1e6; // 0.05 BTC
        bool usesPrepaid = false;
        bytes32 nonce = bytes32(uint256(2));

        // Create signature
        bytes32 messageHash = keccak256(abi.encodePacked(
            user1,
            usdcAmount,
            btcAmount,
            usesPrepaid,
            nonce,
            block.chainid
        ));
        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(backendSignerKey, ethSignedMessageHash);
        bytes memory signature = abi.encodePacked(r, s, v);

        // Approve USDC spending
        usdc.approve(address(dca), usdcAmount);

        // Expect event
        vm.expectEmit(true, true, true, true);
        emit PaymentProcessed(user1, usdcAmount, btcAmount, 1, usesPrepaid);

        // Make payment
        dca.makePayment(
            usdcAmount,
            btcAmount,
            usesPrepaid,
            nonce,
            signature
        );

        // Verify payment
        BitmorDCA.UserPlan memory plan = dca.getUserPlan(user1);
        assertEq(plan.btcAccumulated, btcAmount);
        assertEq(plan.totalPaid, usdcAmount);
        assertEq(plan.streak, 1);

        vm.stopPrank();
    }

    function testEarlyWithdrawal() public {
        // Setup: Create plan and make payment
        testMakePayment();

        vm.startPrank(user1);
        vm.warp(block.timestamp + 31 days); // Move past withdrawal delay

        // Withdrawal parameters
        uint128 btcAmount = 5 * 1e6; // 0.05 BTC
        uint128 penaltyAmount = 1 * 1e6; // 0.01 BTC penalty
        uint128 withdrawAmount = btcAmount - penaltyAmount; // Expected withdrawal amount
        uint32 daysRemaining = 334; // 365 - 31
        bytes32 nonce = bytes32(uint256(3));

        // Create signature
        bytes32 messageHash = keccak256(abi.encodePacked(
            user1,
            btcAmount,
            penaltyAmount,
            daysRemaining,
            nonce,
            block.chainid
        ));
        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(backendSignerKey, ethSignedMessageHash);
        bytes memory signature = abi.encodePacked(r, s, v);

        // Early withdraw
        vm.mockCall(
            address(aavePool),
            abi.encodeWithSelector(IAavePool.withdraw.selector),
            abi.encode(btcAmount)
        );
        
        dca.earlyWithdraw(
            btcAmount,
            penaltyAmount,
            daysRemaining,
            nonce,
            signature
        );

        // Verify withdrawal
        BitmorDCA.UserPlan memory plan = dca.getUserPlan(user1);
        assertEq(uint8(plan.status), uint8(BitmorDCA.PlanStatus.EARLY_EXIT));
        assertEq(plan.btcAccumulated, 0);
        assertEq(cbBTC.balanceOf(user1), withdrawAmount);

        vm.stopPrank();
    }

    function _setupTokenBalances() internal {
        // Mint tokens to users
        vm.startPrank(owner);
        
        // User1 balances
        usdc.mint(user1, 100_000 * 1e6); // 100,000 USDC
        cbBTC.mint(user1, 10 * 1e8); // 10 cbBTC
        
        // User2 balances
        usdc.mint(user2, 100_000 * 1e6);
        cbBTC.mint(user2, 10 * 1e8);
        
        // Contract balances (for rewards/penalties)
        cbBTC.mint(address(dca), 100 * 1e8); // 100 cbBTC reserve
        
        // Pre-mint cbBTC for test payments
        cbBTC.mint(address(this), 1000 * 1e8); // 1000 cbBTC for tests
        cbBTC.approve(address(dca), type(uint256).max);
        
        vm.stopPrank();
    }

    // Additional test cases...
    function testPrepayDays() public {
        // TODO: Implement test
    }

    function testCompletePlan() public {
        // TODO: Implement test
    }

    function testDistributeRewards() public {
        // TODO: Implement test
    }

    function testSweepDust() public {
        // TODO: Implement test
    }

    function testBitmorThreshold() public {
        // TODO: Implement test
    }

    // Failure cases...
    function testCannotCreateDuplicatePlan() public {
        testCreateDCAPlan();
        vm.startPrank(user1);
        
        // Try to create another plan
        uint128 targetBTC = 1e8;
        uint128 dailyAmount = 100 * 1e6;
        uint32 timePeriod = 365;
        uint32 withdrawalDelay = 30;
        BitmorDCA.Cadence cadence = BitmorDCA.Cadence.DAILY;
        bool bitmorEnabled = true;
        bytes32 nonce = bytes32(uint256(4));

        bytes32 messageHash = keccak256(abi.encodePacked(
            user1, targetBTC, dailyAmount, timePeriod, withdrawalDelay,
            cadence, bitmorEnabled, nonce, block.chainid
        ));
        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(backendSignerKey, ethSignedMessageHash);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.expectRevert("Active plan exists");
        dca.createDCAplan(
            targetBTC,
            dailyAmount,
            timePeriod,
            withdrawalDelay,
            cadence,
            bitmorEnabled,
            nonce,
            signature
        );

        vm.stopPrank();
    }

    function testCannotWithdrawBeforeDelay() public {
        testMakePayment();
        vm.startPrank(user1);

        uint128 btcAmount = 5 * 1e6;
        uint128 penaltyAmount = 1 * 1e6;
        uint32 daysRemaining = 364;
        bytes32 nonce = bytes32(uint256(5));

        bytes32 messageHash = keccak256(abi.encodePacked(
            user1, btcAmount, penaltyAmount, daysRemaining, nonce, block.chainid
        ));
        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(backendSignerKey, ethSignedMessageHash);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.expectRevert("Withdrawal delay active");
        dca.earlyWithdraw(
            btcAmount,
            penaltyAmount,
            daysRemaining,
            nonce,
            signature
        );

        vm.stopPrank();
    }
}
