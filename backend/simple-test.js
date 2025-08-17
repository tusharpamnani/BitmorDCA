// Comprehensive test file for BitmorDCA backend with actual smart contract integration
const express = require('express');
const { ethers } = require('ethers');

// Contract configuration
const CONTRACT_ADDRESS = "0x05b60F3E84c2fe6dfC3EA633F336c550AF8335B7";
const BACKEND_SIGNER_PRIVATE_KEY = "0x7da0e539908d8d20c2fb6af64463ff7257a1490ddb3e2e7b1d0b24e972b0cccd";
const TEST_USER_PRIVATE_KEY = "0x1234567890123456789012345678901234567890123456789012345678901234";

// Test addresses (you'll need to fund these with test ETH and USDC)
const TEST_USER_ADDRESS = "0x2b750c56f09178487F9A96FbA240Ea91Ac6F77fD";
const BACKEND_SIGNER_ADDRESS = "0x2b750c56f09178487F9A96FbA240Ea91Ac6F77fD";

// Sepolia testnet configuration
const RPC_URL = "https://eth-sepolia.g.alchemy.com/v2/7KuK_yG_Qri_HaxpeUWTI";
const CHAIN_ID = 11155111;

// Contract ABI (extracted from the main contract functions)
const CONTRACT_ABI = [
    // Core functions
    "function createDCAplan(uint128 targetBTC, uint128 dailyAmount, uint32 timePeriod, uint32 withdrawalDelay, uint8 cadence, bool bitmorEnabled, bytes32 nonce, bytes signature)",
    "function makePayment(uint128 usdcAmount, uint128 btcAmount, bool usesPrepaid, bytes32 nonce, bytes signature)",
    "function prepayDays(uint128 usdcAmount, uint32 days, bytes32 nonce, bytes signature)",
    "function earlyWithdraw(uint128 btcAmount, uint128 penaltyAmount, uint32 daysRemaining, bytes32 nonce, bytes signature)",
    "function completePlan(bytes32 nonce, bytes signature)",
    
    // Rewards and dust
    "function distributeRewards(address[] users, uint128[] amounts, uint128[] boosts, bytes32 nonce, bytes signature)",
    "function claimRewards()",
    "function sweepDust(uint128[] tokenAmounts, address[] tokens, uint128 expectedBTC, bytes32 nonce, bytes signature)",
    
    // View functions
    "function users(address user) view returns (tuple(uint128 totalPaid, uint128 btcAccumulated, uint128 targetBTC, uint64 startTime, uint64 lastPaymentTime, uint32 streak, uint32 maxStreak, uint32 prepaidDays, uint32 withdrawalDelay, uint32 timePeriod, uint8 cadence, uint8 status, bool bitmorEnabled, bool thresholdReached))",
    "function userExtras(address user) view returns (tuple(uint128 rewardBalance, uint128 dustBalance, uint128 yieldBoost, uint64 lastRewardClaim, uint32 rewardWeight))",
    "function usedNonces(bytes32 nonce) view returns (bool)",
    "function totalValueLocked() view returns (uint256)",
    "function rewardsPool() view returns (uint256)",
    
    // Events
    "event PlanCreated(address indexed user, uint128 targetBTC, uint128 dailyAmount, uint32 timePeriod, uint8 cadence, bool bitmorEnabled)",
    "event PaymentProcessed(address indexed user, uint128 usdcAmount, uint128 btcAmount, uint32 streak, bool usesPrepaid)",
    "event EarlyWithdrawal(address indexed user, uint128 btcAmount, uint128 penalty, uint32 daysRemaining)",
    "event RewardsDistributed(address indexed user, uint128 rewardAmount, uint128 yieldBoost)",
    "event DustSwept(address indexed user, uint128 dustAmount, uint128 btcAmount)"
];

// USDC ABI (for token interactions)
const USDC_ABI = [
    "function balanceOf(address account) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function transferFrom(address from, address to, uint256 amount) returns (bool)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
];

// Test USDC address on Sepolia (you'll need to replace with actual test USDC)
const TEST_USDC_ADDRESS = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"; // Example Sepolia USDC

// Setup providers and contracts
const provider = new ethers.JsonRpcProvider(RPC_URL);
const backendWallet = new ethers.Wallet(BACKEND_SIGNER_PRIVATE_KEY, provider);
const testUserWallet = new ethers.Wallet(TEST_USER_PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, backendWallet);
const usdcContract = new ethers.Contract(TEST_USDC_ADDRESS, USDC_ABI, testUserWallet);

// Create a simple Express app for testing
const app = express();
app.use(express.json());

// Utility functions
function generateNonce() {
    return ethers.id(Date.now().toString() + Math.random().toString());
}

async function signMessage(messageHash) {
    return await backendWallet.signMessage(ethers.getBytes(messageHash));
}

async function verifyUserBalance(address) {
    try {
        const balance = await provider.getBalance(address);
        const usdcBalance = await usdcContract.balanceOf(address);
        return {
            eth: ethers.formatEther(balance),
            usdc: ethers.formatUnits(usdcBalance, 6)
        };
    } catch (error) {
        console.log(`Error checking balance: ${error.message}`);
        return { eth: '0', usdc: '0' };
    }
}

// Mock endpoints that interact with the real contract
app.get('/api/health', async (req, res) => {
    try {
        // Check contract connection
        const totalValueLocked = await contract.totalValueLocked();
        const rewardsPool = await contract.rewardsPool();
        
        res.json({
            success: true,
            status: 'healthy',
            data: {
                contractAddress: CONTRACT_ADDRESS,
                totalValueLocked: totalValueLocked.toString(),
                rewardsPool: rewardsPool.toString(),
                network: 'Sepolia Testnet',
                chainId: CHAIN_ID
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Contract connection failed',
            details: error.message
        });
    }
});

app.post('/api/dca/create', async (req, res) => {
    try {
        const { user, targetBTC, dailyAmount, timePeriod, withdrawalDelay, cadence, bitmorEnabled, nonce, signature } = req.body;
        
        if (!user || !targetBTC || !dailyAmount || !timePeriod || !withdrawalDelay || !cadence || !nonce || !signature) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }
        
        // Convert to contract format
        const targetBTCWei = ethers.parseEther(targetBTC.toString());
        const dailyAmountWei = ethers.parseUnits(dailyAmount.toString(), 6); // USDC has 6 decimals
        const cadenceEnum = cadence === "DAILY" ? 0 : 1;
        
        // Create transaction
        const tx = await contract.createDCAplan(
            targetBTCWei,
            dailyAmountWei,
            timePeriod,
            withdrawalDelay,
            cadenceEnum,
            bitmorEnabled,
            nonce,
            signature
        );
        
        // Wait for transaction
        const receipt = await tx.wait();
        
        res.json({
            success: true,
            data: {
                planId: receipt.hash,
                user,
                targetBTC,
                dailyAmount,
                timePeriod,
                withdrawalDelay,
                cadence,
                bitmorEnabled,
                transactionHash: receipt.hash,
                blockNumber: receipt.blockNumber
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Contract interaction failed',
            details: error.message
        });
    }
});

app.post('/api/payments/process', async (req, res) => {
    try {
        const { user, usdcAmount, btcAmount, usesPrepaid, nonce, signature } = req.body;
        
        if (!user || !usdcAmount || !btcAmount || !nonce || !signature) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }
        
        // Convert to contract format
        const usdcAmountWei = ethers.parseUnits(usdcAmount.toString(), 6);
        const btcAmountWei = ethers.parseEther(btcAmount.toString());
        
        // First approve USDC spending
        const approveTx = await usdcContract.approve(CONTRACT_ADDRESS, usdcAmountWei);
        await approveTx.wait();
        
        // Create payment transaction
        const tx = await contract.makePayment(
            usdcAmountWei,
            btcAmountWei,
            usesPrepaid,
            nonce,
            signature
        );
        
        const receipt = await tx.wait();
        
        res.json({
            success: true,
            data: {
                paymentId: receipt.hash,
                user,
                usdcAmount,
                btcAmount,
                usesPrepaid,
                transactionHash: receipt.hash,
                blockNumber: receipt.blockNumber,
                timestamp: Date.now()
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Payment processing failed',
            details: error.message
        });
    }
});

app.get('/api/users/:address/plan', async (req, res) => {
    try {
        const { address } = req.params;
        
        if (!address) {
            return res.status(400).json({ success: false, error: 'Missing address' });
        }
        
        // Get user plan from contract
        const userPlan = await contract.users(address);
        
        res.json({
            success: true,
            data: {
                address,
                totalPaid: ethers.formatUnits(userPlan.totalPaid, 6),
                btcAccumulated: ethers.formatEther(userPlan.btcAccumulated),
                targetBTC: ethers.formatEther(userPlan.targetBTC),
                startTime: userPlan.startTime.toString(),
                lastPaymentTime: userPlan.lastPaymentTime.toString(),
                streak: userPlan.streak.toString(),
                maxStreak: userPlan.maxStreak.toString(),
                prepaidDays: userPlan.prepaidDays.toString(),
                withdrawalDelay: userPlan.withdrawalDelay.toString(),
                timePeriod: userPlan.timePeriod.toString(),
                cadence: userPlan.cadence === 0 ? 'DAILY' : 'WEEKLY',
                status: ['INACTIVE', 'ACTIVE', 'PAUSED', 'COMPLETED', 'EARLY_EXIT'][userPlan.status],
                bitmorEnabled: userPlan.bitmorEnabled,
                thresholdReached: userPlan.thresholdReached
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to get user plan',
            details: error.message
        });
    }
});

app.get('/api/users/:address/extras', async (req, res) => {
    try {
        const { address } = req.params;
        
        if (!address) {
            return res.status(400).json({ success: false, error: 'Missing address' });
        }
        
        // Get user extras from contract
        const userExtras = await contract.userExtras(address);
        
        res.json({
            success: true,
            data: {
                address,
                rewardBalance: ethers.formatUnits(userExtras.rewardBalance, 6),
                dustBalance: ethers.formatUnits(userExtras.dustBalance, 6),
                yieldBoost: ethers.formatUnits(userExtras.yieldBoost, 6),
                lastRewardClaim: userExtras.lastRewardClaim.toString(),
                rewardWeight: userExtras.rewardWeight.toString()
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to get user extras',
            details: error.message
        });
    }
});

app.get('/api/contract/stats', async (req, res) => {
    try {
        const totalValueLocked = await contract.totalValueLocked();
        const rewardsPool = await contract.rewardsPool();
        
        res.json({
            success: true,
            data: {
                totalValueLocked: ethers.formatUnits(totalValueLocked, 6),
                rewardsPool: ethers.formatUnits(rewardsPool, 6),
                contractAddress: CONTRACT_ADDRESS,
                network: 'Sepolia Testnet'
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to get contract stats',
            details: error.message
        });
    }
});

// Test data
const testUser = TEST_USER_ADDRESS;

// Comprehensive test function
async function runContractTests() {
    console.log('🧪 Running BitmorDCA Smart Contract Tests...\n');
    
    const tests = [
        {
            name: 'Health Check',
            endpoint: '/api/health',
            method: 'GET',
            data: null
        },
        {
            name: 'Contract Stats',
            endpoint: '/api/contract/stats',
            method: 'GET',
            data: null
        },
        {
            name: 'User Plan (Before Creation)',
            endpoint: `/api/users/${testUser}/plan`,
            method: 'GET',
            data: null
        },
        {
            name: 'User Extras (Before Creation)',
            endpoint: `/api/users/${testUser}/extras`,
            method: 'GET',
            data: null
        }
    ];

    let passedTests = 0;
    let totalTests = tests.length;

    // Check user balances first
    console.log('💰 Checking user balances...');
    try {
        const balances = await verifyUserBalance(testUser);
        console.log(`   ETH Balance: ${balances.eth}`);
        console.log(`   USDC Balance: ${balances.usdc}`);
        
        if (parseFloat(balances.eth) < 0.01) {
            console.log('⚠️  Warning: Low ETH balance. Tests may fail.');
        }
        if (parseFloat(balances.usdc) < 100) {
            console.log('⚠️  Warning: Low USDC balance. Tests may fail.');
        }
    } catch (error) {
        console.log(`❌ Balance check failed: ${error.message}`);
    }

    console.log('\n📋 Running contract tests...\n');

    for (let i = 0; i < tests.length; i++) {
        const test = tests[i];
        console.log(`${i + 1}. Testing ${test.name}...`);
        
        try {
            const options = {
                method: test.method,
                headers: { 'Content-Type': 'application/json' }
            };
            
            if (test.data) {
                options.body = JSON.stringify(test.data);
            }
            
            const response = await fetch(`http://localhost:3001${test.endpoint}`, options);
            const data = await response.json();
            
            if (data.success || response.status === 200) {
                console.log(`✅ ${test.name} passed`);
                if (data.data) {
                    console.log(`   Data: ${JSON.stringify(data.data, null, 2)}`);
                }
                passedTests++;
            } else {
                console.log(`❌ ${test.name} failed: ${data.error || 'Unknown error'}`);
                if (data.details) {
                    console.log(`   Details: ${data.details}`);
                }
            }
        } catch (error) {
            console.log(`❌ ${test.name} failed: ${error.message}`);
        }
        
        console.log(''); // Add spacing
    }

    // Test contract interaction (if user has sufficient balance)
    console.log(`${totalTests + 1}. Testing Contract Interaction...`);
    try {
        const balances = await verifyUserBalance(testUser);
        
        if (parseFloat(balances.eth) > 0.01 && parseFloat(balances.usdc) > 100) {
            // Generate test data for plan creation
            const nonce = generateNonce();
            const targetBTC = 0.001; // 0.001 BTC
            const dailyAmount = 10; // 10 USDC
            const timePeriod = 30; // 30 days
            const withdrawalDelay = 7; // 7 days
            const cadence = "DAILY";
            const bitmorEnabled = true;
            
            // Create message hash for signature
            const messageHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
                ["address", "uint128", "uint128", "uint32", "uint32", "uint8", "bool", "bytes32", "uint256"],
                [testUser, ethers.parseEther(targetBTC.toString()), ethers.parseUnits(dailyAmount.toString(), 6), timePeriod, withdrawalDelay, 0, bitmorEnabled, nonce, CHAIN_ID]
            ));
            
            const signature = await signMessage(messageHash);
            
            const planData = {
                user: testUser,
                targetBTC,
                dailyAmount,
                timePeriod,
                withdrawalDelay,
                cadence,
                bitmorEnabled,
                nonce,
                signature
            };
            
            const response = await fetch('http://localhost:3001/api/dca/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(planData)
            });
            
            const data = await response.json();
            if (data.success) {
                console.log('✅ Contract interaction test passed');
                console.log(`   Transaction Hash: ${data.data.transactionHash}`);
                passedTests++;
            } else {
                console.log(`❌ Contract interaction failed: ${data.error}`);
                if (data.details) {
                    console.log(`   Details: ${data.details}`);
                }
            }
        } else {
            console.log('⚠️  Skipping contract interaction test - insufficient balance');
        }
    } catch (error) {
        console.log(`❌ Contract interaction test failed: ${error.message}`);
    }
    
    totalTests++;
    
    console.log(`\n📊 Test Results: ${passedTests}/${totalTests} tests passed`);
    console.log(`🎉 Smart contract test suite completed!`);
    
    // Final balance check
    console.log('\n💰 Final balance check...');
    try {
        const finalBalances = await verifyUserBalance(testUser);
        console.log(`   ETH Balance: ${finalBalances.eth}`);
        console.log(`   USDC Balance: ${finalBalances.usdc}`);
    } catch (error) {
        console.log(`❌ Final balance check failed: ${error.message}`);
    }
}

// Start the server and run tests
const server = app.listen(3001, async () => {
    console.log('🚀 Smart Contract Test Server started on port 3001');
    console.log(`📋 Contract Address: ${CONTRACT_ADDRESS}`);
    console.log(`🌐 Network: Sepolia Testnet (Chain ID: ${CHAIN_ID})`);
    console.log(`👤 Test User: ${TEST_USER_ADDRESS}`);
    console.log(`🔐 Backend Signer: ${BACKEND_SIGNER_ADDRESS}`);
    
    // Wait a moment for server to start
    setTimeout(async () => {
        await runContractTests();
        server.close(() => {
            console.log('🔚 Test server closed');
            process.exit(0);
        });
    }, 1000);
});

// Handle server errors
server.on('error', (error) => {
    console.error('❌ Server error:', error);
    process.exit(1);
});
