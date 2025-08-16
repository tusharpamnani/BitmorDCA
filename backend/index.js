// BitmorDCA Backend API - Node.js + Express + TypeScript
// Package.json dependencies needed:
// express, cors, helmet, dotenv, ethers, node-cron, redis, pg, winston

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { ethers } = require('ethers');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Configuration
const CONFIG = {
    RPC_URL: process.env.RPC_URL,
    PRIVATE_KEY: process.env.BACKEND_PRIVATE_KEY,
    CONTRACT_ADDRESS: process.env.CONTRACT_ADDRESS,
    CHAINLINK_BTC_FEED: process.env.CHAINLINK_BTC_FEED,
    AAVE_POOL: process.env.AAVE_POOL,
    USDC_ADDRESS: process.env.USDC_ADDRESS,
    CBBTC_ADDRESS: process.env.CBBTC_ADDRESS,
    BITMOR_API_URL: process.env.BITMOR_API_URL,
    BITMOR_API_KEY: process.env.BITMOR_API_KEY,
    REDIS_URL: process.env.REDIS_URL,
    DB_URL: process.env.DATABASE_URL
};

// Ethers setup
const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
const wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);

// Contract ABI
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
    
    // Bitmor integration
    "function triggerBitmorThreshold(uint128 btcAmount, bytes32 nonce, bytes signature)",
    
    // View functions
    "function getUserPlan(address user) view returns (tuple(uint128 totalPaid, uint128 btcAccumulated, uint128 targetBTC, uint64 startTime, uint64 lastPaymentTime, uint32 streak, uint32 maxStreak, uint32 prepaidDays, uint32 withdrawalDelay, uint32 timePeriod, uint8 cadence, uint8 status, bool bitmorEnabled, bool thresholdReached))",
    "function getUserExtras(address user) view returns (tuple(uint128 rewardBalance, uint128 dustBalance, uint128 yieldBoost, uint64 lastRewardClaim, uint32 rewardWeight))",
    "function getStrategy(uint256 strategyId) view returns (tuple(uint128 targetBTC, uint128 dailyAmount, uint32 timePeriod, uint32 withdrawalDelay, uint16 penaltyMin, uint16 penaltyMax, uint16 fee, uint8 cadence, address creator, bool isActive))",
    "function getAaveYield() view returns (uint256)",
    
    // Events
    "event PlanCreated(address indexed user, uint128 targetBTC, uint128 dailyAmount, uint32 timePeriod, uint8 cadence, bool bitmorEnabled)",
    "event PaymentProcessed(address indexed user, uint128 usdcAmount, uint128 btcAmount, uint32 streak, bool usesPrepaid)",
    "event EarlyWithdrawal(address indexed user, uint128 btcAmount, uint128 penalty, uint32 daysRemaining)",
    "event BitmorThresholdReached(address indexed user, uint128 btcAmount, uint128 loanAmount)",
    "event RewardsDistributed(address indexed user, uint128 rewardAmount, uint128 yieldBoost)",
    "event DustSwept(address indexed user, uint128 dustAmount, uint128 btcAmount)"
];

// Chainlink Price Feed ABI
const CHAINLINK_ABI = [
    "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"
];

const contract = new ethers.Contract(CONFIG.CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
const priceFeed = new ethers.Contract(CONFIG.CHAINLINK_BTC_FEED, CHAINLINK_ABI, provider);

// Database client
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Redis client for caching
const Redis = require('redis');
const redisClient = Redis.createClient({
    url: CONFIG.REDIS_URL
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));

// Utility Functions
class BitmorDCAService {
    static async getBTCPrice() {
        try {
            // First check Redis cache
            const cachedPrice = await redisClient.get('btc_price');
            if (cachedPrice) {
                return ethers.parseUnits(cachedPrice, 10);
            }

            // If not in cache, fetch from Chainlink
            const [, price] = await priceFeed.latestRoundData();
            const priceStr = price.toString();
            
            // Cache for 1 minute
            await redisClient.set('btc_price', priceStr, 'EX', 60);
            
            // Store in price history
            await prisma.priceHistory.create({
                data: {
                    asset: 'BTC',
                    price: parseFloat(ethers.formatUnits(price, 10))
                }
            });

            return ethers.parseUnits(priceStr, 10);
        } catch (error) {
            console.error('Error fetching BTC price:', error);
            throw new Error('Failed to fetch BTC price');
        }
    }
    
    static async getBTCAmount(usdcAmount) {
        const btcPrice = await this.getBTCPrice();
        return (ethers.parseEther(usdcAmount.toString()) * ethers.parseEther("1")) / btcPrice;
    }
    
    static calculateDailyAmount(targetBTC, timePeriodDays, btcPrice) {
        const totalUSDCNeeded = (targetBTC * btcPrice) / ethers.parseEther("1");
        return totalUSDCNeeded / BigInt(timePeriodDays);
    }
    
    static calculatePenalty(user, currentTime, plan) {
        const timeElapsed = Math.floor((currentTime - user.startTime.getTime()) / 1000);
        const totalTime = plan.timePeriod * 24 * 60 * 60; // days to seconds
        const timeRemaining = Math.max(0, totalTime - timeElapsed);
        
        if (timeRemaining === 0) return plan.penaltyMin;
        
        const fracLeft = (timeRemaining * 10000) / totalTime;
        const fracLeftPowered = Math.pow(fracLeft / 10000, plan.penaltyExponent);
        
        const penalty = plan.penaltyMin + 
            ((plan.penaltyMax - plan.penaltyMin) * fracLeftPowered);
        
        return Math.floor(penalty);
    }
    
    static generateNonce() {
        return ethers.id(Date.now().toString() + Math.random().toString());
    }
    
    static async signMessage(messageHash) {
        return await wallet.signMessage(ethers.getBytes(messageHash));
    }
    
    static createConfigHash(config) {
        return ethers.id(JSON.stringify(config));
    }
    
    static async checkBitmorEligibility(userAddress, btcAmount) {
        try {
            // First check Redis cache
            const cacheKey = `bitmor_eligibility:${userAddress}`;
            const cachedResult = await redisClient.get(cacheKey);
            if (cachedResult) {
                return JSON.parse(cachedResult).eligible;
            }

            // If not in cache, call Bitmor API
            const response = await fetch(`${CONFIG.BITMOR_API_URL}/check-eligibility`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${CONFIG.BITMOR_API_KEY}`
                },
                body: JSON.stringify({
                    userAddress,
                    collateralAmount: btcAmount.toString()
                })
            });
            
            const data = await response.json();
            
            // Cache result for 5 minutes
            await redisClient.set(cacheKey, JSON.stringify(data), 'EX', 300);
            
            return data.eligible;
        } catch (error) {
            console.error('Bitmor API error:', error);
            return false;
        }
    }

    static async getUserByAddress(address) {
        return await prisma.dCAUser.findUnique({
            where: { address },
            include: { plans: true }
        });
    }

    static async createUser(address) {
        return await prisma.dCAUser.create({
            data: {
                address,
                totalPaid: 0,
                btcAccumulated: 0,
                startTime: new Date(),
                lastPaymentTime: new Date(),
                streak: 0,
                prepaidDays: 0,
                status: 1,
                bitmorEnabled: false,
                thresholdReached: false
            }
        });
    }

    static async createPlan(userId, planData) {
        return await prisma.dCAPlan.create({
            data: {
                userId,
                ...planData
            }
        });
    }

    static async recordPayment(planId, amount, btcAmount, usesPrepaid = false) {
        return await prisma.dCAPayment.create({
            data: {
                planId,
                amount,
                btcAmount,
                usesPrepaid,
                status: 'completed',
                completedAt: new Date()
            }
        });
    }
}

// API Routes

// 1. Plan Creation and Management
app.post('/api/plans/create', async (req, res) => {
    try {
        const {
            userAddress,
            targetBTC,
            timePeriodDays,
            withdrawalDelayDays,
            penaltyMin,
            penaltyMax,
            penaltyExponent,
            cadence,
            bitmorIntegration,
            tokens // Array of {tokenId, amount, weight}
        } = req.body;
        
        // Input validation
        if (!ethers.isAddress(userAddress)) {
            return res.status(400).json({ error: 'Invalid user address' });
        }
        
        if (timePeriodDays < 1) {
            return res.status(400).json({ error: 'Time period must be at least 1 day' });
        }
        
        if (withdrawalDelayDays < 7) {
            return res.status(400).json({ error: 'Withdrawal delay must be at least 7 days' });
        }
        
        if (penaltyMin < 0 || penaltyMax > 100 || penaltyMin > penaltyMax) {
            return res.status(400).json({ error: 'Invalid penalty configuration' });
        }
        
        if (!['daily', 'weekly'].includes(cadence)) {
            return res.status(400).json({ error: 'Invalid cadence. Must be daily or weekly' });
        }

        if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
            return res.status(400).json({ error: 'At least one token must be specified' });
        }

        // Validate token weights sum to 100%
        const totalWeight = tokens.reduce((sum, t) => sum + t.weight, 0);
        if (Math.abs(totalWeight - 100) > 0.01) {
            return res.status(400).json({ error: 'Token weights must sum to 100%' });
        }
        
        // Get or create user
        let user = await BitmorDCAService.getUserByAddress(userAddress.toLowerCase());
        if (!user) {
            user = await BitmorDCAService.createUser(userAddress.toLowerCase());
        }
        
        // Calculate amounts
        const btcPrice = await BitmorDCAService.getBTCPrice();
        const totalDailyAmount = BitmorDCAService.calculateDailyAmount(
            ethers.parseEther(targetBTC.toString()),
            timePeriodDays,
            btcPrice
        );

        // Validate tokens and get their details
        const supportedTokens = await prisma.supportedToken.findMany({
            where: {
                id: {
                    in: tokens.map(t => t.tokenId)
                },
                isEnabled: true
            }
        });

        if (supportedTokens.length !== tokens.length) {
            return res.status(400).json({ error: 'One or more tokens are not supported' });
        }

        // Create transaction
        const plan = await prisma.$transaction(async (prisma) => {
            // Create the main plan
            const plan = await prisma.dCAPlan.create({
                data: {
                    userId: user.id,
                    targetBTC: parseFloat(targetBTC),
                    totalDailyAmount: totalDailyAmount,
                    timePeriod: timePeriodDays,
                    withdrawalDelay: withdrawalDelayDays,
                    penaltyMin: penaltyMin,
                    penaltyMax: penaltyMax,
                    penaltyExponent: penaltyExponent || 1.5,
                    cadence: cadence,
                    graceWindow: 1,
                    isActive: true
                }
            });

            // Create token allocations
            const tokenCreations = tokens.map(token => {
                const supportedToken = supportedTokens.find(st => st.id === token.tokenId);
                const dailyAmount = (totalDailyAmount * token.weight) / 100;

                if (dailyAmount < supportedToken.minAmount || dailyAmount > supportedToken.maxAmount) {
                    throw new Error(`Invalid amount for token ${supportedToken.symbol}`);
                }

                return prisma.planToken.create({
                    data: {
                        planId: plan.id,
                        tokenId: token.tokenId,
                        dailyAmount: dailyAmount,
                        weight: token.weight
                    }
                });
            });

            await Promise.all(tokenCreations);
            
            return plan;
        });
        
        // Create plan in database
        const createdPlan = await BitmorDCAService.createPlan(user.id, {
            targetBTC: parseFloat(targetBTC),
            dailyAmount: parseFloat(ethers.formatUnits(dailyAmount, 6)),
            timePeriod: timePeriodDays,
            withdrawalDelay: withdrawalDelayDays,
            penaltyMin: parseFloat(penaltyMin),
            penaltyMax: parseFloat(penaltyMax),
            penaltyExponent: penaltyExponent || 1.5,
            cadence
        });
        
        // Create config hash for contract
        const planConfig = {
            targetBTC: ethers.parseEther(targetBTC.toString()).toString(),
            dailyAmount: dailyAmount.toString(),
            timePeriod: timePeriodDays,
            withdrawalDelay: withdrawalDelayDays,
            penaltyMin,
            penaltyMax,
            penaltyExponent: penaltyExponent || 1.5,
            cadence,
            planId: plan.id
        };
        
        const configHash = BitmorDCAService.createConfigHash(planConfig);
        
        // Create signature for contract interaction
        const messageHash = ethers.solidityPackedKeccak256(
            ['address', 'bytes32', 'bool', 'uint256'],
            [userAddress, configHash, bitmorIntegration, 1] // chainId = 1 for mainnet
        );
        
        const signature = await BitmorDCAService.signMessage(messageHash);
        
        // Cache plan config for quick access
        await redisClient.set(
            `plan_config:${plan.id}`,
            JSON.stringify(planConfig),
            'EX',
            24 * 60 * 60 // 24 hours
        );
        
        res.json({
            success: true,
            data: {
                planId: plan.id,
                configHash,
                signature,
                planConfig,
                dailyAmountUSDC: ethers.formatUnits(dailyAmount, 6)
            }
        });
        
    } catch (error) {
        console.error('Error creating plan:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 2. Payment Processing
app.post('/api/payments/calculate', async (req, res) => {
    try {
        const { userAddress } = req.body;
        
        if (!ethers.isAddress(userAddress)) {
            return res.status(400).json({ error: 'Invalid user address' });
        }
        
        // Get user and active plans
        const user = await BitmorDCAService.getUserByAddress(userAddress.toLowerCase());
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const activePlans = await prisma.dCAPlan.findMany({
            where: {
                userId: user.id,
                isActive: true
            },
            include: {
                payments: {
                    orderBy: {
                        createdAt: 'desc'
                    },
                    take: 1
                }
            }
        });
        
        if (activePlans.length === 0) {
            return res.status(404).json({ error: 'No active plans found' });
        }
        
        // Get current user state from contract
        const userState = await contract.users(userAddress);
        
        // Check if payment is due for any plan
        const currentTime = Math.floor(Date.now() / 1000);
        const usesPrepaid = userState.prepaidDays > 0;
        
        const duePlans = activePlans.filter(plan => {
            const lastPayment = plan.payments[0];
            if (!lastPayment) return true; // First payment is always due
            
            const nextPaymentTime = lastPayment.createdAt.getTime() / 1000 + 
                (plan.cadence === 'daily' ? 24 * 60 * 60 : 7 * 24 * 60 * 60);
            
            return currentTime >= nextPaymentTime;
        });
        
        if (duePlans.length === 0 && !usesPrepaid) {
            return res.status(400).json({ error: 'No payments due yet' });
        }
        
        // Calculate total amounts for all due plans
        let totalUSDCAmount = BigInt(0);
        let totalBTCAmount = BigInt(0);
        
        for (const plan of duePlans) {
            const usdcAmount = ethers.parseUnits(plan.dailyAmount.toString(), 6);
            totalUSDCAmount += usdcAmount;
            
            const btcAmount = await BitmorDCAService.getBTCAmount(
                ethers.formatUnits(usdcAmount, 6)
            );
            totalBTCAmount += btcAmount;
        }
        
        const nonce = BitmorDCAService.generateNonce();
        
        // Create signature
        const messageHash = ethers.solidityPackedKeccak256(
            ['address', 'uint128', 'uint128', 'bool', 'bytes32', 'uint256'],
            [userAddress, totalUSDCAmount, totalBTCAmount, usesPrepaid, nonce, 1]
        );
        
        const signature = await BitmorDCAService.signMessage(messageHash);
        
        // Cache payment details
        await redisClient.set(
            `payment:${nonce}`,
            JSON.stringify({
                userAddress,
                plans: duePlans.map(p => p.id),
                usdcAmount: totalUSDCAmount.toString(),
                btcAmount: totalBTCAmount.toString(),
                usesPrepaid
            }),
            'EX',
            15 * 60 // 15 minutes
        );
        
        res.json({
            success: true,
            data: {
                usdcAmount: totalUSDCAmount.toString(),
                btcAmount: totalBTCAmount.toString(),
                usesPrepaid,
                nonce,
                signature,
                usdcAmountFormatted: ethers.formatUnits(totalUSDCAmount, 6),
                btcAmountFormatted: ethers.formatEther(totalBTCAmount),
                duePlans: duePlans.map(p => ({
                    id: p.id,
                    dailyAmount: p.dailyAmount,
                    cadence: p.cadence
                }))
            }
        });
        
    } catch (error) {
        console.error('Error calculating payment:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 3. Penalty Calculation for Early Withdrawal
app.post('/api/penalties/calculate', async (req, res) => {
    try {
        const { userAddress, planId } = req.body;
        
        if (!ethers.isAddress(userAddress)) {
            return res.status(400).json({ error: 'Invalid user address' });
        }
        
        // Get user and plan
        const user = await BitmorDCAService.getUserByAddress(userAddress.toLowerCase());
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const plan = await prisma.dCAPlan.findFirst({
            where: {
                id: planId,
                userId: user.id,
                isActive: true
            }
        });
        
        if (!plan) {
            return res.status(404).json({ error: 'Active plan not found' });
        }
        
        // Get current user state from contract
        const userState = await contract.users(userAddress);
        
        if (userState.btcAccumulated === 0) {
            return res.status(400).json({ error: 'No BTC to withdraw' });
        }
        
        // Check withdrawal delay
        const lastPayment = await prisma.dCAPayment.findFirst({
            where: {
                planId: plan.id,
                status: 'completed'
            },
            orderBy: {
                completedAt: 'desc'
            }
        });
        
        if (lastPayment) {
            const withdrawalDelaySeconds = plan.withdrawalDelay * 24 * 60 * 60;
            const currentTime = Math.floor(Date.now() / 1000);
            const lastPaymentTime = Math.floor(lastPayment.completedAt.getTime() / 1000);
            
            if (currentTime - lastPaymentTime < withdrawalDelaySeconds) {
                return res.status(400).json({
                    error: 'Withdrawal delay not met',
                    remainingTime: withdrawalDelaySeconds - (currentTime - lastPaymentTime)
                });
            }
        }
        
        // Calculate penalty
        const penaltyBasisPoints = BitmorDCAService.calculatePenalty(
            user,
            Date.now(),
            plan
        );
        
        const penaltyAmount = (userState.btcAccumulated * BigInt(penaltyBasisPoints)) / BigInt(10000);
        const withdrawAmount = userState.btcAccumulated - penaltyAmount;
        
        const nonce = BitmorDCAService.generateNonce();
        
        // Create signature
        const messageHash = ethers.solidityPackedKeccak256(
            ['address', 'uint128', 'bytes32', 'uint256', 'string'],
            [userAddress, penaltyAmount, nonce, 1, plan.id]
        );
        
        const signature = await BitmorDCAService.signMessage(messageHash);
        
        // Cache withdrawal request
        await redisClient.set(
            `withdrawal:${nonce}`,
            JSON.stringify({
                userAddress,
                planId: plan.id,
                penaltyAmount: penaltyAmount.toString(),
                withdrawAmount: withdrawAmount.toString(),
                penaltyBasisPoints
            }),
            'EX',
            15 * 60 // 15 minutes
        );
        
        res.json({
            success: true,
            data: {
                planId: plan.id,
                penaltyAmount: penaltyAmount.toString(),
                withdrawAmount: withdrawAmount.toString(),
                penaltyBasisPoints,
                nonce,
                signature,
                penaltyAmountFormatted: ethers.formatEther(penaltyAmount),
                withdrawAmountFormatted: ethers.formatEther(withdrawAmount),
                planDetails: {
                    targetBTC: plan.targetBTC,
                    dailyAmount: plan.dailyAmount,
                    timePeriod: plan.timePeriod,
                    withdrawalDelay: plan.withdrawalDelay,
                    cadence: plan.cadence
                }
            }
        });
        
    } catch (error) {
        console.error('Error calculating penalty:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 4. Strategy Management
app.post('/api/strategies/create', async (req, res) => {
    try {
        const {
            creatorAddress,
            name,
            targetBTC,
            timePeriodDays,
            withdrawalDelayDays,
            penaltyMin,
            penaltyMax,
            penaltyExponent,
            cadence,
            fee
        } = req.body;
        
        // Input validation
        if (!ethers.isAddress(creatorAddress)) {
            return res.status(400).json({ error: 'Invalid creator address' });
        }
        
        if (!name || name.trim().length === 0) {
            return res.status(400).json({ error: 'Strategy name is required' });
        }
        
        if (timePeriodDays < 1) {
            return res.status(400).json({ error: 'Time period must be at least 1 day' });
        }
        
        if (withdrawalDelayDays < 7) {
            return res.status(400).json({ error: 'Withdrawal delay must be at least 7 days' });
        }
        
        if (penaltyMin < 0 || penaltyMax > 100 || penaltyMin > penaltyMax) {
            return res.status(400).json({ error: 'Invalid penalty configuration' });
        }
        
        if (!['daily', 'weekly'].includes(cadence)) {
            return res.status(400).json({ error: 'Invalid cadence. Must be daily or weekly' });
        }
        
        const btcPrice = await BitmorDCAService.getBTCPrice();
        const dailyAmount = BitmorDCAService.calculateDailyAmount(
            ethers.parseEther(targetBTC.toString()),
            timePeriodDays,
            btcPrice
        );
        
        // Create strategy in database
        const strategy = await prisma.dCAStrategy.create({
            data: {
                name,
                creator: creatorAddress.toLowerCase(),
                targetBTC: parseFloat(targetBTC),
                dailyAmount: parseFloat(ethers.formatUnits(dailyAmount, 6)),
                timePeriod: timePeriodDays,
                withdrawalDelay: withdrawalDelayDays,
                penaltyMin: parseFloat(penaltyMin),
                penaltyMax: parseFloat(penaltyMax),
                penaltyExponent: penaltyExponent || 1.5,
                cadence,
                fee: fee || 100 // 1% default
            }
        });
        
        // Create config hash for contract
        const strategyConfig = {
            name,
            creator: creatorAddress,
            targetBTC: ethers.parseEther(targetBTC.toString()).toString(),
            dailyAmount: dailyAmount.toString(),
            timePeriod: timePeriodDays,
            withdrawalDelay: withdrawalDelayDays,
            penaltyMin,
            penaltyMax,
            penaltyExponent: penaltyExponent || 1.5,
            cadence,
            fee: fee || 100,
            strategyId: strategy.id
        };
        
        const configHash = BitmorDCAService.createConfigHash(strategyConfig);
        
        // Create signature for contract interaction
        const messageHash = ethers.solidityPackedKeccak256(
            ['address', 'bytes32', 'uint16', 'uint256', 'string'],
            [creatorAddress, configHash, fee || 100, 1, strategy.id]
        );
        
        const signature = await BitmorDCAService.signMessage(messageHash);
        
        // Cache strategy config
        await redisClient.set(
            `strategy:${strategy.id}`,
            JSON.stringify(strategyConfig),
            'EX',
            24 * 60 * 60 // 24 hours
        );
        
        res.json({
            success: true,
            data: {
                strategyId: strategy.id,
                configHash,
                signature,
                strategyConfig: {
                    ...strategyConfig,
                    dailyAmountFormatted: ethers.formatUnits(dailyAmount, 6)
                }
            }
        });
        
    } catch (error) {
        console.error('Error creating strategy:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 5. Bitmor Integration
app.post('/api/bitmor/check-threshold', async (req, res) => {
    try {
        const { userAddress, planId } = req.body;
        
        if (!ethers.isAddress(userAddress)) {
            return res.status(400).json({ error: 'Invalid user address' });
        }
        
        // Get user and plan
        const user = await BitmorDCAService.getUserByAddress(userAddress.toLowerCase());
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const plan = await prisma.dCAPlan.findFirst({
            where: {
                id: planId,
                userId: user.id,
                isActive: true
            }
        });
        
        if (!plan) {
            return res.status(404).json({ error: 'Active plan not found' });
        }
        
        // Get current user state from contract
        const userState = await contract.users(userAddress);
        
        if (!userState.bitmorEnabled || userState.thresholdReached) {
            return res.status(400).json({ error: 'Bitmor not enabled or already triggered' });
        }
        
        // Calculate progress
        const targetBTC = ethers.parseEther(plan.targetBTC.toString());
        const progressPct = (userState.btcAccumulated * BigInt(100)) / targetBTC;
        
        if (progressPct < BigInt(25)) { // 25% threshold
            return res.status(400).json({
                error: 'Threshold not reached yet',
                currentProgress: progressPct.toString(),
                requiredProgress: '25'
            });
        }
        
        // Check Bitmor eligibility
        const isEligible = await BitmorDCAService.checkBitmorEligibility(
            userAddress, 
            userState.btcAccumulated
        );
        
        if (!isEligible) {
            return res.status(400).json({ error: 'Not eligible for Bitmor loan' });
        }
        
        const nonce = BitmorDCAService.generateNonce();
        
        // Create signature
        const messageHash = ethers.solidityPackedKeccak256(
            ['address', 'uint128', 'string', 'bytes32', 'uint256', 'string'],
            [userAddress, userState.btcAccumulated, "BITMOR_THRESHOLD", nonce, 1, plan.id]
        );
        
        const signature = await BitmorDCAService.signMessage(messageHash);
        
        // Cache Bitmor threshold check
        await redisClient.set(
            `bitmor_threshold:${nonce}`,
            JSON.stringify({
                userAddress,
                planId: plan.id,
                btcAmount: userState.btcAccumulated.toString(),
                progressPct: progressPct.toString()
            }),
            'EX',
            15 * 60 // 15 minutes
        );
        
        // Get total value in USDC
        const btcPrice = await BitmorDCAService.getBTCPrice();
        const totalValueUSDC = (userState.btcAccumulated * btcPrice) / ethers.parseEther("1");
        
        res.json({
            success: true,
            data: {
                planId: plan.id,
                btcAmount: userState.btcAccumulated.toString(),
                progressPct: progressPct.toString(),
                nonce,
                signature,
                btcAmountFormatted: ethers.formatEther(userState.btcAccumulated),
                totalValueUSDC: ethers.formatUnits(totalValueUSDC, 6),
                planDetails: {
                    targetBTC: plan.targetBTC,
                    dailyAmount: plan.dailyAmount,
                    timePeriod: plan.timePeriod,
                    withdrawalDelay: plan.withdrawalDelay,
                    cadence: plan.cadence
                }
            }
        });
        
    } catch (error) {
        console.error('Error checking Bitmor threshold:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 6. Plan Analytics
app.get('/api/plans/:userAddress/analytics', async (req, res) => {
    try {
        const { userAddress } = req.params;
        
        if (!ethers.isAddress(userAddress)) {
            return res.status(400).json({ error: 'Invalid user address' });
        }
        
        // Get user and all active plans
        const user = await BitmorDCAService.getUserByAddress(userAddress.toLowerCase());
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const activePlans = await prisma.dCAPlan.findMany({
            where: {
                userId: user.id,
                isActive: true
            },
            include: {
                payments: {
                    orderBy: {
                        createdAt: 'desc'
                    }
                }
            }
        });
        
        if (activePlans.length === 0) {
            return res.status(404).json({ error: 'No active plans found' });
        }
        
        // Get current user state from contract
        const userState = await contract.users(userAddress);
        
        // Get current BTC price
        const btcPrice = await BitmorDCAService.getBTCPrice();
        
        // Calculate analytics for each plan
        const planAnalytics = await Promise.all(activePlans.map(async (plan) => {
            const currentTime = Math.floor(Date.now() / 1000);
            const startTime = plan.payments[0]?.createdAt.getTime() / 1000 || currentTime;
            const timeElapsed = currentTime - startTime;
            const totalTime = plan.timePeriod * 24 * 60 * 60;
            const timeLeftDays = Math.max(0, Math.floor((totalTime - timeElapsed) / (24 * 60 * 60)));
            
            const targetBTC = ethers.parseEther(plan.targetBTC.toString());
            const progressPct = targetBTC > 0 ? 
                Number((userState.btcAccumulated * BigInt(100)) / targetBTC) : 0;
            
            // Calculate total paid and average price for this plan
            const totalPaidUSDC = plan.payments.reduce((sum, payment) => sum + payment.amount, 0);
            const totalBTCAccumulated = plan.payments.reduce((sum, payment) => sum + payment.btcAmount, 0);
            
            const avgPurchasePrice = totalBTCAccumulated > 0 ? 
                totalPaidUSDC / totalBTCAccumulated : 0;
            
            // Calculate streak
            let currentStreak = 0;
            if (plan.payments.length > 0) {
                const lastPaymentTime = plan.payments[0].createdAt.getTime() / 1000;
                const expectedInterval = plan.cadence === 'daily' ? 24 * 60 * 60 : 7 * 24 * 60 * 60;
                
                if (currentTime - lastPaymentTime <= expectedInterval) {
                    currentStreak = plan.payments.reduce((streak, payment, i, arr) => {
                        if (i === 0) return 1;
                        const timeDiff = arr[i-1].createdAt.getTime() - payment.createdAt.getTime();
                        return timeDiff <= expectedInterval ? streak + 1 : streak;
                    }, 0);
                }
            }
            
            return {
                planId: plan.id,
                progress: {
                    btcAccumulated: totalBTCAccumulated.toString(),
                    targetBTC: plan.targetBTC.toString(),
                    progressPct,
                    timeLeftDays
                },
                financial: {
                    totalPaid: totalPaidUSDC.toString(),
                    currentValue: (totalBTCAccumulated * parseFloat(ethers.formatUnits(btcPrice, 18))).toString(),
                    avgPurchasePrice: avgPurchasePrice.toString(),
                    currentBTCPrice: ethers.formatUnits(btcPrice, 18)
                },
                activity: {
                    streak: currentStreak,
                    totalPayments: plan.payments.length,
                    lastPaymentTime: plan.payments[0]?.createdAt.getTime() || 0,
                    cadence: plan.cadence
                },
                settings: {
                    dailyAmount: plan.dailyAmount,
                    withdrawalDelay: plan.withdrawalDelay,
                    penaltyMin: plan.penaltyMin,
                    penaltyMax: plan.penaltyMax
                }
            };
        }));
        
        // Calculate aggregated stats
        const totalBTCAccumulated = planAnalytics.reduce(
            (sum, plan) => sum + parseFloat(plan.progress.btcAccumulated), 
            0
        );
        
        const totalUSDCPaid = planAnalytics.reduce(
            (sum, plan) => sum + parseFloat(plan.financial.totalPaid), 
            0
        );
        
        const avgProgressPct = planAnalytics.reduce(
            (sum, plan) => sum + plan.progress.progressPct, 
            0
        ) / planAnalytics.length;
        
        res.json({
            success: true,
            data: {
                userAddress,
                totalPlans: planAnalytics.length,
                aggregated: {
                    totalBTCAccumulated: totalBTCAccumulated.toString(),
                    totalUSDCPaid: totalUSDCPaid.toString(),
                    avgProgressPct: avgProgressPct.toString(),
                    currentBTCPrice: ethers.formatUnits(btcPrice, 18)
                },
                bitmor: {
                    enabled: userState.bitmorEnabled,
                    thresholdReached: userState.thresholdReached,
                    eligibleForThreshold: avgProgressPct >= 25
                },
                plans: planAnalytics
            }
        });
        
    } catch (error) {
        console.error('Error fetching analytics:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 7. Rewards Distribution (Cron Job)
app.post('/api/rewards/distribute', async (req, res) => {
    try {
        // This would typically be called by a cron job
        // For demo, allowing manual trigger
        
        // Get all active users with their plans and payments
        const users = await prisma.dCAUser.findMany({
            where: {
                plans: {
                    some: {
                        isActive: true
                    }
                }
            },
            include: {
                plans: {
                    where: {
                        isActive: true
                    },
                    include: {
                        payments: {
                            orderBy: {
                                createdAt: 'desc'
                            }
                        }
                    }
                }
            }
        });
        
        const eligibleUsers = [];
        const rewardAmounts = [];
        const rewardDetails = [];
        
        const currentTime = Math.floor(Date.now() / 1000);
        
        for (const user of users) {
            try {
                const userState = await contract.users(user.address);
                
                // Calculate total rewards across all active plans
                let totalReward = 0;
                const planRewards = [];
                
                for (const plan of user.plans) {
                    // Calculate streak for this plan
                    let currentStreak = 0;
                    if (plan.payments.length > 0) {
                        const lastPaymentTime = plan.payments[0].createdAt.getTime() / 1000;
                        const expectedInterval = plan.cadence === 'daily' ? 24 * 60 * 60 : 7 * 24 * 60 * 60;
                        
                        if (currentTime - lastPaymentTime <= expectedInterval) {
                            currentStreak = plan.payments.reduce((streak, payment, i, arr) => {
                                if (i === 0) return 1;
                                const timeDiff = arr[i-1].createdAt.getTime() - payment.createdAt.getTime();
                                return timeDiff <= expectedInterval ? streak + 1 : streak;
                            }, 0);
                        }
                    }
                    
                    // Check if plan is eligible for rewards
                    if (currentStreak > 0 && currentStreak % 7 === 0) {
                        const streakWeight = currentStreak * 100;
                        const commitmentWeight = plan.payments.reduce((sum, p) => sum + p.amount, 0) / 1000;
                        const penaltyWeight = plan.penaltyMax;
                        
                        const totalWeight = streakWeight + commitmentWeight + penaltyWeight;
                        const reward = Math.floor(totalWeight / 1000); // Simplified calculation
                        
                        if (reward > 0) {
                            totalReward += reward;
                            planRewards.push({
                                planId: plan.id,
                                streak: currentStreak,
                                reward
                            });
                        }
                    }
                }
                
                if (totalReward > 0) {
                    eligibleUsers.push(user.address);
                    rewardAmounts.push(totalReward);
                    rewardDetails.push({
                        userAddress: user.address,
                        totalReward,
                        planRewards
                    });
                }
            } catch (error) {
                console.error(`Error processing rewards for ${user.address}:`, error);
            }
        }
        
        if (eligibleUsers.length === 0) {
            return res.json({ success: true, message: 'No eligible users for rewards' });
        }
        
        const nonce = BitmorDCAService.generateNonce();
        
        // Create signature for batch reward distribution
        const messageHash = ethers.solidityPackedKeccak256(
            ['address[]', 'uint128[]', 'bytes32', 'uint256'],
            [eligibleUsers, rewardAmounts, nonce, 1]
        );
        
        const signature = await BitmorDCAService.signMessage(messageHash);
        
        // Cache reward distribution details
        await redisClient.set(
            `rewards:${nonce}`,
            JSON.stringify({
                eligibleUsers,
                rewardAmounts,
                rewardDetails
            }),
            'EX',
            15 * 60 // 15 minutes
        );
        
        res.json({
            success: true,
            data: {
                eligibleUsers,
                rewardAmounts,
                nonce,
                signature,
                totalRewards: rewardAmounts.reduce((sum, amount) => sum + amount, 0),
                rewardDetails
            }
        });
        
    } catch (error) {
        console.error('Error distributing rewards:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 8. User Balance and Stats
app.get('/api/users/:address/balance', async (req, res) => {
    try {
        const { address } = req.params;
        
        if (!ethers.isAddress(address)) {
            return res.status(400).json({ error: 'Invalid user address' });
        }
        
        // Get user from database
        const user = await prisma.dCAUser.findUnique({
            where: { address: address.toLowerCase() },
            include: {
                plans: {
                    where: { isActive: true },
                    include: {
                        payments: {
                            where: { status: 'completed' }
                        }
                    }
                },
                withdrawals: {
                    where: { status: 'completed' }
                },
                deposits: {
                    where: { status: 'completed' }
                }
            }
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Get on-chain cbBTC balance
        const cbBTCBalance = await contract.getAccumulatedBTC(address);
        
        // Calculate total BTC accumulated (including withdrawn)
        const totalBTCAccumulated = user.btcAccumulated;
        const totalWithdrawn = user.withdrawals.reduce((sum, w) => sum + w.btcAmount, 0);
        const totalDeposited = user.deposits.reduce((sum, d) => sum + d.btcAmount, 0);
        
        // Calculate total paid in fees
        const totalPenaltyPaid = user.totalPenaltyPaid;
        
        res.json({
            cbBTCBalance: ethers.formatEther(cbBTCBalance),
            totalBTCAccumulated,
            totalWithdrawn,
            totalDeposited,
            totalPenaltyPaid,
            currentBalance: user.btcAccumulated
        });
    } catch (error) {
        console.error('Error fetching user balance:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 9. Early Withdrawal Fee
app.get('/api/plans/:planId/withdrawal-fee', async (req, res) => {
    try {
        const { planId } = req.params;
        
        // Get plan from database
        const plan = await prisma.dCAPlan.findUnique({
            where: { id: planId },
            include: {
                user: true,
                payments: {
                    where: { status: 'completed' }
                }
            }
        });

        if (!plan) {
            return res.status(404).json({ error: 'Plan not found' });
        }

        // Calculate days remaining in plan
        const now = new Date();
        const startDate = plan.createdAt;
        const endDate = new Date(startDate.getTime() + plan.timePeriod * 24 * 60 * 60 * 1000);
        const daysRemaining = Math.ceil((endDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

        if (daysRemaining <= 0) {
            return res.json({ fee: 0, daysRemaining: 0 });
        }

        // Calculate penalty based on plan parameters
        const progress = 1 - (daysRemaining / plan.timePeriod);
        const penaltyPercentage = plan.penaltyMin + (plan.penaltyMax - plan.penaltyMin) * 
            Math.pow(1 - progress, plan.penaltyExponent);

        // Calculate total value locked
        const totalValueLocked = plan.btcAccumulated * await BitmorDCAService.getBTCPrice();
        const estimatedFee = (totalValueLocked * penaltyPercentage) / 100;

        res.json({
            fee: estimatedFee,
            daysRemaining,
            penaltyPercentage,
            totalValueLocked,
            progress: progress * 100
        });
    } catch (error) {
        console.error('Error calculating withdrawal fee:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 10. Referral System
app.get('/api/users/:address/referral', async (req, res) => {
    try {
        const { address } = req.params;
        
        if (!ethers.isAddress(address)) {
            return res.status(400).json({ error: 'Invalid user address' });
        }
        
        const user = await prisma.dCAUser.findUnique({
            where: { address: address.toLowerCase() },
            include: {
                referrals: {
                    include: {
                        referred: true
                    }
                }
            }
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Get referral statistics
        const totalReferrals = user.referrals.length;
        const activeReferrals = user.referrals.filter(r => r.status === 'active').length;
        const totalRewards = user.referrals.reduce((sum, r) => sum + r.rewardAmount, 0);
        
        res.json({
            referralCode: user.referralCode,
            referralLink: `${process.env.FRONTEND_URL}/register?ref=${user.referralCode}`,
            totalReferrals,
            activeReferrals,
            totalRewards,
            referrals: user.referrals.map(r => ({
                address: r.referred.address,
                status: r.status,
                rewardAmount: r.rewardAmount,
                joinedAt: r.createdAt
            }))
        });
    } catch (error) {
        console.error('Error fetching referral info:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/referral/use', async (req, res) => {
    try {
        const { userAddress, referralCode } = req.body;
        
        if (!ethers.isAddress(userAddress)) {
            return res.status(400).json({ error: 'Invalid user address' });
        }

        // Find referrer by referral code
        const referrer = await prisma.dCAUser.findUnique({
            where: { referralCode }
        });

        if (!referrer) {
            return res.status(404).json({ error: 'Invalid referral code' });
        }

        // Check if user exists
        let user = await prisma.dCAUser.findUnique({
            where: { address: userAddress.toLowerCase() }
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Check if user already has a referrer
        if (user.referredBy) {
            return res.status(400).json({ error: 'User already has a referrer' });
        }

        // Create referral relationship
        await prisma.referral.create({
            data: {
                referrerId: referrer.id,
                referredId: user.id,
                status: 'pending'
            }
        });

        // Update user with referral info
        await prisma.dCAUser.update({
            where: { id: user.id },
            data: { referredBy: referrer.id }
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Error using referral code:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 11. User Statistics
app.get('/api/users/:address/stats', async (req, res) => {
    try {
        const { address } = req.params;
        
        if (!ethers.isAddress(address)) {
            return res.status(400).json({ error: 'Invalid user address' });
        }
        
        const user = await prisma.dCAUser.findUnique({
            where: { address: address.toLowerCase() },
            include: {
                plans: {
                    include: {
                        payments: {
                            where: { status: 'completed' }
                        }
                    }
                },
                deposits: {
                    where: { status: 'completed' }
                },
                withdrawals: {
                    where: { status: 'completed' }
                },
                referrals: true,
                rewards: {
                    where: { claimed: true }
                }
            }
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Calculate DCA statistics
        const totalDCAExecuted = user.plans.reduce((sum, plan) => 
            sum + plan.payments.reduce((pSum, p) => pSum + p.amount, 0), 0);
        
        // Calculate dust sweep earnings
        const dustSweepEarnings = user.totalDustEarned;
        
        // Calculate penalties paid
        const totalPenalties = user.totalPenaltyPaid;
        
        // Get referral stats
        const referralStats = {
            totalReferrals: user.referrals.length,
            activeReferrals: user.referrals.filter(r => r.status === 'active').length,
            totalRewards: user.referrals.reduce((sum, r) => sum + r.rewardAmount, 0)
        };
        
        // Calculate rewards
        const totalRewards = user.rewards.reduce((sum, r) => sum + r.amount, 0);
        
        res.json({
            address: user.address,
            startTime: user.startTime,
            currentStreak: user.currentStreak,
            maxStreak: user.maxStreak,
            statistics: {
                totalDCAExecuted,
                dustSweepEarnings,
                totalPenalties,
                totalRewards,
                totalBTCAccumulated: user.btcAccumulated,
                totalDeposited: user.deposits.reduce((sum, d) => sum + d.amount, 0),
                totalWithdrawn: user.withdrawals.reduce((sum, w) => sum + w.amount, 0)
            },
            referralStats,
            activePlans: user.plans.filter(p => p.isActive).length,
            completedPlans: user.plans.filter(p => !p.isActive).length
        });
    } catch (error) {
        console.error('Error fetching user stats:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 12. Token Management
app.get('/api/tokens/supported', async (req, res) => {
    try {
        const supportedTokens = await prisma.supportedToken.findMany({
            where: {
                isEnabled: true
            },
            orderBy: {
                symbol: 'asc'
            }
        });

        res.json({
            tokens: supportedTokens.map(token => ({
                id: token.id,
                symbol: token.symbol,
                name: token.name,
                address: token.address,
                decimals: token.decimals,
                isStablecoin: token.isStablecoin,
                minAmount: token.minAmount,
                maxAmount: token.maxAmount
            }))
        });
    } catch (error) {
        console.error('Error fetching supported tokens:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/users/:address/token-balances', async (req, res) => {
    try {
        const { address } = req.params;
        
        if (!ethers.isAddress(address)) {
            return res.status(400).json({ error: 'Invalid user address' });
        }

        // Get all supported tokens
        const supportedTokens = await prisma.supportedToken.findMany({
            where: {
                isEnabled: true
            }
        });

        // Get balances for all supported tokens
        const balances = await Promise.all(
            supportedTokens.map(async (token) => {
                const contract = new ethers.Contract(
                    token.address,
                    ['function balanceOf(address) view returns (uint256)'],
                    provider
                );
                const balance = await contract.balanceOf(address);
                return {
                    token: {
                        id: token.id,
                        symbol: token.symbol,
                        name: token.name,
                        address: token.address,
                        decimals: token.decimals
                    },
                    balance: ethers.formatUnits(balance, token.decimals),
                    raw: balance.toString()
                };
            })
        );

        res.json({ balances });
    } catch (error) {
        console.error('Error fetching token balances:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 13. Dust Sweeping
app.post('/api/dust/calculate', async (req, res) => {
    try {
        const { userAddress } = req.body;
        
        if (!ethers.isAddress(userAddress)) {
            return res.status(400).json({ error: 'Invalid user address' });
        }
        
        // Get user and active plans
        const user = await BitmorDCAService.getUserByAddress(userAddress.toLowerCase());
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const activePlans = await prisma.dCAPlan.findMany({
            where: {
                userId: user.id,
                isActive: true
            },
            orderBy: {
                dailyAmount: 'asc' // Get smallest DCA amount first
            }
        });
        
        if (activePlans.length === 0) {
            return res.status(404).json({ error: 'No active plans found' });
        }
        
        // Get dust balances from contract
        const dustBalances = await Promise.all([
            contract.getDustBalance(userAddress, CONFIG.USDC_ADDRESS),
            contract.getDustBalance(userAddress, CONFIG.CBBTC_ADDRESS)
        ]);
        
        // Convert all dust to USDC value
        let totalDustUSDC = BigInt(0);
        
        // USDC dust
        totalDustUSDC += dustBalances[0];
        
        // cbBTC dust
        if (dustBalances[1] > 0) {
            const btcPrice = await BitmorDCAService.getBTCPrice();
            const btcDustValue = (dustBalances[1] * btcPrice) / ethers.parseEther("1");
            totalDustUSDC += btcDustValue;
        }
        
        const dustThreshold = ethers.parseUnits("10", 6); // $10 USDC threshold
        
        if (totalDustUSDC < dustThreshold) {
            return res.status(400).json({
                error: 'Dust below threshold',
                currentDust: ethers.formatUnits(totalDustUSDC, 6),
                requiredDust: ethers.formatUnits(dustThreshold, 6)
            });
        }
        
        // Calculate how many days of DCA this dust can cover for each plan
        const planCoverage = activePlans.map(plan => {
            const dailyAmount = ethers.parseUnits(plan.dailyAmount.toString(), 6);
            const dcaDays = Number(totalDustUSDC / dailyAmount);
            
            return {
                planId: plan.id,
                dailyAmount: plan.dailyAmount,
                dcaDays,
                totalCoverage: ethers.formatUnits(dailyAmount * BigInt(dcaDays), 6)
            };
        });
        
        // Find optimal plan to use dust with
        const optimalPlan = planCoverage.reduce((best, current) => {
            // Prefer plans that can cover more days
            if (current.dcaDays > best.dcaDays) return current;
            // If same days, prefer larger daily amounts
            if (current.dcaDays === best.dcaDays && current.dailyAmount > best.dailyAmount) return current;
            return best;
        }, planCoverage[0]);
        
        const nonce = BitmorDCAService.generateNonce();
        
        // Create signature
        const messageHash = ethers.solidityPackedKeccak256(
            ['address', 'uint32', 'bytes32', 'uint256', 'string'],
            [userAddress, optimalPlan.dcaDays, nonce, 1, optimalPlan.planId]
        );
        
        const signature = await BitmorDCAService.signMessage(messageHash);
        
        // Cache dust sweep details
        await redisClient.set(
            `dust_sweep:${nonce}`,
            JSON.stringify({
                userAddress,
                planId: optimalPlan.planId,
                dustBalance: totalDustUSDC.toString(),
                dcaDays: optimalPlan.dcaDays
            }),
            'EX',
            15 * 60 // 15 minutes
        );
        
        res.json({
            success: true,
            data: {
                dustBalance: totalDustUSDC.toString(),
                dustBalanceFormatted: ethers.formatUnits(totalDustUSDC, 6),
                optimalPlan: {
                    planId: optimalPlan.planId,
                    dailyAmount: optimalPlan.dailyAmount,
                    dcaDays: optimalPlan.dcaDays,
                    totalCoverage: optimalPlan.totalCoverage
                },
                allPlans: planCoverage,
                nonce,
                signature
            }
        });
        
    } catch (error) {
        console.error('Error calculating dust sweep:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 9. Plan Completion Verification
app.post('/api/plans/verify-completion', async (req, res) => {
    try {
        const { userAddress, planId } = req.body;
        
        if (!ethers.isAddress(userAddress)) {
            return res.status(400).json({ error: 'Invalid user address' });
        }
        
        // Get user and plan
        const user = await BitmorDCAService.getUserByAddress(userAddress.toLowerCase());
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const plan = await prisma.dCAPlan.findFirst({
            where: {
                id: planId,
                userId: user.id,
                isActive: true
            },
            include: {
                payments: {
                    orderBy: {
                        createdAt: 'desc'
                    }
                }
            }
        });
        
        if (!plan) {
            return res.status(404).json({ error: 'Active plan not found' });
        }
        
        // Get current user state from contract
        const userState = await contract.users(userAddress);
        
        // Calculate total BTC accumulated for this plan
        const totalBTCAccumulated = plan.payments.reduce((sum, payment) => sum + payment.btcAmount, 0);
        const targetBTC = ethers.parseEther(plan.targetBTC.toString());
        
        // Check if plan is completed
        const isCompleted = totalBTCAccumulated >= parseFloat(ethers.formatEther(targetBTC));
        
        if (!isCompleted) {
            return res.status(400).json({
                error: 'Plan not yet completed',
                currentProgress: {
                    btcAccumulated: totalBTCAccumulated.toString(),
                    targetBTC: plan.targetBTC.toString(),
                    progressPct: (totalBTCAccumulated / parseFloat(plan.targetBTC) * 100).toFixed(2)
                }
            });
        }
        
        // Check if all payments were made on schedule
        let allPaymentsOnTime = true;
        let missedPayments = 0;
        
        if (plan.payments.length > 1) {
            const expectedInterval = plan.cadence === 'daily' ? 24 * 60 * 60 : 7 * 24 * 60 * 60;
            
            for (let i = 1; i < plan.payments.length; i++) {
                const timeDiff = plan.payments[i-1].createdAt.getTime() - plan.payments[i].createdAt.getTime();
                if (timeDiff > expectedInterval * 1000) {
                    allPaymentsOnTime = false;
                    missedPayments++;
                }
            }
        }
        
        const nonce = BitmorDCAService.generateNonce();
        
        // Create signature
        const messageHash = ethers.solidityPackedKeccak256(
            ['address', 'string', 'bytes32', 'uint256', 'string'],
            [userAddress, "COMPLETE", nonce, 1, planId]
        );
        
        const signature = await BitmorDCAService.signMessage(messageHash);
        
        // Cache completion verification
        await redisClient.set(
            `completion:${nonce}`,
            JSON.stringify({
                userAddress,
                planId,
                totalBTCAccumulated: totalBTCAccumulated.toString(),
                allPaymentsOnTime,
                missedPayments
            }),
            'EX',
            15 * 60 // 15 minutes
        );
        
        // Get current BTC value
        const btcPrice = await BitmorDCAService.getBTCPrice();
        const currentValue = (BigInt(Math.floor(totalBTCAccumulated * 1e18)) * btcPrice) / ethers.parseEther("1");
        
        res.json({
            success: true,
            data: {
                planId,
                btcAmount: totalBTCAccumulated.toString(),
                targetReached: true,
                allPaymentsOnTime,
                missedPayments,
                nonce,
                signature,
                btcAmountFormatted: totalBTCAccumulated.toString(),
                currentValue: ethers.formatUnits(currentValue, 6),
                planStats: {
                    totalPayments: plan.payments.length,
                    startDate: plan.payments[plan.payments.length - 1].createdAt,
                    endDate: plan.payments[0].createdAt,
                    avgPurchasePrice: (plan.payments.reduce((sum, p) => sum + p.amount, 0) / totalBTCAccumulated).toString()
                }
            }
        });
        
    } catch (error) {
        console.error('Error verifying completion:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 10. Health Check & Status
app.get('/api/health', async (req, res) => {
    try {
        // Check database connection
        await prisma.$queryRaw`SELECT 1`;
        
        // Check Redis connection
        await redisClient.ping();
        
        // Check blockchain connection
        const btcPrice = await BitmorDCAService.getBTCPrice();
        const blockNumber = await provider.getBlockNumber();
        
        // Get system stats
        const [
            activePlansCount,
            activeUsersCount,
            totalStrategiesCount,
            totalPaymentsCount,
            totalBTCAccumulated
        ] = await Promise.all([
            prisma.dCAPlan.count({ where: { isActive: true } }),
            prisma.dCAUser.count(),
            prisma.dCAStrategy.count({ where: { isActive: true } }),
            prisma.dCAPayment.count({ where: { status: 'completed' } }),
            prisma.dCAPayment.aggregate({
                _sum: {
                    btcAmount: true
                },
                where: {
                    status: 'completed'
                }
            })
        ]);
        
        // Get latest price history
        const latestPrices = await prisma.priceHistory.findMany({
            where: {
                asset: 'BTC'
            },
            orderBy: {
                fetchedAt: 'desc'
            },
            take: 24 // Last 24 entries
        });
        
        // Calculate 24h price change
        const priceChange24h = latestPrices.length >= 2 ? 
            ((latestPrices[0].price - latestPrices[latestPrices.length - 1].price) / 
             latestPrices[latestPrices.length - 1].price * 100).toFixed(2) : 
            '0';
        
        res.json({
            success: true,
            data: {
                status: 'healthy',
                services: {
                    database: 'connected',
                    redis: 'connected',
                    blockchain: {
                        connected: true,
                        blockNumber,
                        network: await provider.getNetwork()
                    }
                },
                prices: {
                    btcPrice: ethers.formatUnits(btcPrice, 18),
                    priceChange24h,
                    lastUpdate: latestPrices[0]?.fetchedAt
                },
                stats: {
                    activePlans: activePlansCount,
                    activeUsers: activeUsersCount,
                    totalStrategies: totalStrategiesCount,
                    totalPayments: totalPaymentsCount,
                    totalBTCAccumulated: totalBTCAccumulated._sum.btcAmount?.toString() || '0'
                },
                system: {
                    timestamp: Date.now(),
                    uptime: process.uptime(),
                    memory: process.memoryUsage(),
                    environment: process.env.NODE_ENV || 'development'
                }
            }
        });
    } catch (error) {
        console.error('Health check failed:', error);
        
        // Try to determine which service failed
        let failedService = 'unknown';
        if (error.message.includes('database')) failedService = 'database';
        else if (error.message.includes('redis')) failedService = 'redis';
        else if (error.message.includes('provider')) failedService = 'blockchain';
        
        res.status(500).json({ 
            success: false, 
            error: 'Service unhealthy',
            failedService,
            details: error.message 
        });
    }
});

// Cron Jobs for Automated Tasks

// Every 5 minutes - Update BTC price
cron.schedule('*/5 * * * *', async () => {
    try {
        console.log('Updating BTC price...');
        const btcPrice = await BitmorDCAService.getBTCPrice();
        
        // Store in price history
        await prisma.priceHistory.create({
            data: {
                asset: 'BTC',
                price: parseFloat(ethers.formatUnits(btcPrice, 18))
            }
        });
        
        // Update Redis cache
        await redisClient.set('btc_price', btcPrice.toString(), 'EX', 300);
        
        console.log('BTC price updated successfully');
    } catch (error) {
        console.error('Error updating BTC price:', error);
    }
});

// Every hour - Check for missed payments
cron.schedule('0 * * * *', async () => {
    try {
        console.log('Checking for missed payments...');
        const currentTime = Math.floor(Date.now() / 1000);
        
        // Get all active plans
        const activePlans = await prisma.dCAPlan.findMany({
            where: {
                isActive: true
            },
            include: {
                user: true,
                payments: {
                    orderBy: {
                        createdAt: 'desc'
                    },
                    take: 1
                }
            }
        });
        
        for (const plan of activePlans) {
            try {
                const lastPayment = plan.payments[0];
                if (!lastPayment) continue; // Skip new plans
                
                const lastPaymentTime = Math.floor(lastPayment.createdAt.getTime() / 1000);
                const expectedInterval = plan.cadence === 'daily' ? 24 * 60 * 60 : 7 * 24 * 60 * 60;
                
                if (currentTime - lastPaymentTime > expectedInterval) {
                    // Payment is overdue
                    console.log(`Missed payment detected for plan ${plan.id}`);
                    
                    // Send notification (implement your notification system)
                    // await notificationService.sendMissedPaymentAlert(plan.user.address, plan.id);
                    
                    // Update streak if needed
                    if (currentTime - lastPaymentTime > expectedInterval * 2) {
                        await prisma.dCAPlan.update({
                            where: { id: plan.id },
                            data: {
                                streak: 0
                            }
                        });
                    }
                }
            } catch (error) {
                console.error(`Error processing plan ${plan.id}:`, error);
            }
        }
        
        console.log('Missed payments check completed');
    } catch (error) {
        console.error('Error checking missed payments:', error);
    }
});

// Every 6 hours - Check for reward distributions
cron.schedule('0 */6 * * *', async () => {
    try {
        console.log('Running automated reward distribution check...');
        
        // Get all active users with their plans and payments
        const users = await prisma.dCAUser.findMany({
            where: {
                plans: {
                    some: {
                        isActive: true
                    }
                }
            },
            include: {
                plans: {
                    where: {
                        isActive: true
                    },
                    include: {
                        payments: {
                            orderBy: {
                                createdAt: 'desc'
                            }
                        }
                    }
                }
            }
        });
        
        const eligibleUsers = [];
        const rewardAmounts = [];
        
        for (const user of users) {
            try {
                let totalReward = 0;
                
                for (const plan of user.plans) {
                    // Calculate streak
                    let currentStreak = 0;
                    if (plan.payments.length > 0) {
                        const lastPaymentTime = plan.payments[0].createdAt.getTime() / 1000;
                        const expectedInterval = plan.cadence === 'daily' ? 24 * 60 * 60 : 7 * 24 * 60 * 60;
                        
                        if (Date.now() / 1000 - lastPaymentTime <= expectedInterval) {
                            currentStreak = plan.payments.reduce((streak, payment, i, arr) => {
                                if (i === 0) return 1;
                                const timeDiff = arr[i-1].createdAt.getTime() - payment.createdAt.getTime();
                                return timeDiff <= expectedInterval ? streak + 1 : streak;
                            }, 0);
                        }
                    }
                    
                    // Check if eligible for rewards
                    if (currentStreak > 0 && currentStreak % 7 === 0) {
                        const streakWeight = currentStreak * 100;
                        const commitmentWeight = plan.payments.reduce((sum, p) => sum + p.amount, 0) / 1000;
                        const penaltyWeight = plan.penaltyMax;
                        
                        const totalWeight = streakWeight + commitmentWeight + penaltyWeight;
                        const reward = Math.floor(totalWeight / 1000);
                        
                        if (reward > 0) {
                            totalReward += reward;
                        }
                    }
                }
                
                if (totalReward > 0) {
                    eligibleUsers.push(user.address);
                    rewardAmounts.push(totalReward);
                }
            } catch (error) {
                console.error(`Error processing rewards for ${user.address}:`, error);
            }
        }
        
        if (eligibleUsers.length > 0) {
            const nonce = BitmorDCAService.generateNonce();
            
            // Create signature for batch reward distribution
            const messageHash = ethers.solidityPackedKeccak256(
                ['address[]', 'uint128[]', 'bytes32', 'uint256'],
                [eligibleUsers, rewardAmounts, nonce, 1]
            );
            
            const signature = await BitmorDCAService.signMessage(messageHash);
            
            // Call contract to distribute rewards
            // await contract.distributeRewards(eligibleUsers, rewardAmounts, nonce, signature);
            
            console.log(`Rewards distributed to ${eligibleUsers.length} users`);
        }
        
        console.log('Reward distribution check completed');
    } catch (error) {
        console.error('Error in reward distribution:', error);
    }
});

// Daily maintenance tasks
cron.schedule('0 0 * * *', async () => {
    try {
        console.log('Running daily maintenance tasks...');
        
        // Clean up old price history (keep last 30 days)
        await prisma.priceHistory.deleteMany({
            where: {
                fetchedAt: {
                    lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
                }
            }
        });
        
        // Clean up Redis cache
        const keys = await redisClient.keys('*');
        for (const key of keys) {
            const ttl = await redisClient.ttl(key);
            if (ttl === -1) { // No expiry set
                await redisClient.del(key);
            }
        }
        
        // Update plan streaks
        const activePlans = await prisma.dCAPlan.findMany({
            where: {
                isActive: true
            },
            include: {
                payments: {
                    orderBy: {
                        createdAt: 'desc'
                    }
                }
            }
        });
        
        for (const plan of activePlans) {
            try {
                if (plan.payments.length === 0) continue;
                
                const lastPaymentTime = plan.payments[0].createdAt.getTime() / 1000;
                const expectedInterval = plan.cadence === 'daily' ? 24 * 60 * 60 : 7 * 24 * 60 * 60;
                
                if (Date.now() / 1000 - lastPaymentTime > expectedInterval * 2) {
                    await prisma.dCAPlan.update({
                        where: { id: plan.id },
                        data: {
                            streak: 0
                        }
                    });
                }
            } catch (error) {
                console.error(`Error updating streak for plan ${plan.id}:`, error);
            }
        }
        
        console.log('Daily maintenance completed');
    } catch (error) {
        console.error('Error in daily maintenance:', error);
    }
});

// Error handling middleware
app.use(async (error, req, res, next) => {
    // Log error details
    console.error('Unhandled error:', {
        error,
        path: req.path,
        method: req.method,
        query: req.query,
        body: req.body,
        user: req.user,
        timestamp: new Date().toISOString()
    });
    
    // Determine error type and appropriate response
    let status = 500;
    let message = 'Internal server error';
    let details = process.env.NODE_ENV === 'development' ? error.message : undefined;
    
    if (error.name === 'PrismaClientKnownRequestError') {
        // Handle Prisma errors
        switch (error.code) {
            case 'P2002':
                status = 409;
                message = 'Resource already exists';
                break;
            case 'P2025':
                status = 404;
                message = 'Resource not found';
                break;
            default:
                message = 'Database error';
        }
    } else if (error.name === 'ValidationError') {
        status = 400;
        message = 'Invalid input data';
        details = error.details;
    } else if (error.name === 'UnauthorizedError') {
        status = 401;
        message = 'Authentication required';
    } else if (error.name === 'ForbiddenError') {
        status = 403;
        message = 'Access denied';
    }
    
    // Store error in database for monitoring
    try {
        await prisma.errorLog.create({
            data: {
                path: req.path,
                method: req.method,
                errorName: error.name,
                errorMessage: error.message,
                errorStack: error.stack,
                status,
                timestamp: new Date()
            }
        });
    } catch (logError) {
        console.error('Failed to log error:', logError);
    }
    
    // Send response
    res.status(status).json({
        success: false,
        error: message,
        ...(details && { details }),
        requestId: req.id // Assuming you're using a request ID middleware
    });
});

// Rate limiting middleware
const rateLimit = require('express-rate-limit');

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: {
        success: false,
        error: 'Too many requests, please try again later'
    }
});

app.use('/api/', apiLimiter);

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        success: false, 
        error: 'Endpoint not found',
        path: req.path,
        method: req.method,
        timestamp: new Date().toISOString()
    });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received. Starting graceful shutdown...');
    
    // Close server
    server.close(() => {
        console.log('HTTP server closed');
    });
    
    try {
        // Close database connection
        await prisma.$disconnect();
        console.log('Database connection closed');
        
        // Close Redis connection
        await redisClient.quit();
        console.log('Redis connection closed');
        
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`BitmorDCA Backend API running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Database: ${process.env.DATABASE_URL.split('@')[1]}`); // Hide credentials
    console.log(`Redis: ${process.env.REDIS_URL.split('@')[1]}`); // Hide credentials
});

module.exports = app;
module.exports = app;