import { ethers } from "ethers";
import { PrismaClient } from "@prisma/client";
import { 
  fetchPrice, 
  swapToCbBTC, 
  depositToAave, 
  withdrawFromAave,
  getAaveYield
} from "./utils";

const prisma = new PrismaClient();

// ENV Variables
const RPC_URL = process.env.RPC_URL!;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS!;
const CONTRACT_ABI = require("./BitmordCA.abi.json");
const UNISWAP_ROUTER = process.env.UNISWAP_ROUTER!;
const AAVE_POOL = process.env.AAVE_POOL!;
const cbBTC_ADDRESS = process.env.cbBTC_ADDRESS!;
const DUST_THRESHOLD = ethers.parseUnits("10", 6); // $10 USDC

// Initialize providers and contracts
const provider = new ethers.JsonRpcProvider(RPC_URL);
const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);

// Price Updates
async function updatePrices() {
  try {
    const btcPrice = await fetchPrice("bitcoin");
    await prisma.priceHistory.create({
      data: {
        asset: "BTC",
        price: btcPrice
      }
    });
    console.log(`[Price Updated] BTC: $${btcPrice}`);
  } catch (error) {
    console.error("[Price Update Failed]", error);
  }
}

// Deposit Processing
async function processDeposit(deposit: any) {
  try {
    // Handle different deposit types
    if (deposit.source === "dust") {
      // Dust sweep
      const dustSweep = await prisma.dustSweep.findUnique({
        where: { id: deposit.sourceToken }
      });
      
      if (!dustSweep) throw new Error("Dust sweep not found");
      
      // Swap all dust tokens to cbBTC
      const swapTx = await swapToCbBTC(
        dustSweep.tokens,
        UNISWAP_ROUTER,
        cbBTC_ADDRESS
      );
      
      // Update dust sweep status
      await prisma.dustSweep.update({
        where: { id: dustSweep.id },
        data: {
          txHash: swapTx.hash,
          status: "completed",
          completedAt: new Date()
        }
      });
    } else {
      // Regular deposit - already in cbBTC
      console.log(`[Regular Deposit] ${deposit.amount} cbBTC`);
    }
    
    // Deposit to Aave
    const aaveDepositTx = await depositToAave(
      deposit.btcAmount,
      AAVE_POOL,
      cbBTC_ADDRESS
    );
    
    // Update deposit status
    await prisma.deposit.update({
      where: { id: deposit.id },
      data: {
        aaveDepositTx: aaveDepositTx.hash,
        status: "completed",
        completedAt: new Date()
      }
    });
    
    console.log(`[Deposit Completed] ID: ${deposit.id}`);
  } catch (error) {
    console.error(`[Deposit Failed] ID: ${deposit.id}`, error);
    
    // Update deposit status to failed
    await prisma.deposit.update({
      where: { id: deposit.id },
      data: {
        status: "failed"
      }
    });
  }
}

// Withdrawal Processing
async function processWithdrawal(withdrawal: any) {
  try {
    // Withdraw from Aave
    const aaveWithdrawTx = await withdrawFromAave(
      withdrawal.btcAmount,
      AAVE_POOL,
      cbBTC_ADDRESS
    );
    
    // Update withdrawal status
    await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: {
        aaveWithdrawTx: aaveWithdrawTx.hash,
        status: "completed",
        completedAt: new Date()
      }
    });
    
    console.log(`[Withdrawal Completed] ID: ${withdrawal.id}`);
  } catch (error) {
    console.error(`[Withdrawal Failed] ID: ${withdrawal.id}`, error);
    
    // Update withdrawal status to failed
    await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: {
        status: "failed"
      }
    });
  }
}

// Streak Management
async function updateStreaks() {
  try {
    const currentTime = new Date();
    
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
        if (plan.payments.length === 0) continue;
        
        const lastPayment = plan.payments[0];
        const lastPaymentTime = lastPayment.createdAt;
        const expectedInterval = plan.cadence === 'daily' ? 
          24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
        
        // Check if payment is late
        if (currentTime.getTime() - lastPaymentTime.getTime() > expectedInterval) {
          // Check grace period
          const graceWindow = plan.cadence === 'daily' ? 7 : 21; // days
          const graceExpiry = new Date(lastPaymentTime.getTime() + graceWindow * 24 * 60 * 60 * 1000);
          
          if (currentTime > graceExpiry) {
            // Reset streak
            await prisma.dCAUser.update({
              where: { id: plan.userId },
              data: {
                currentStreak: 0,
                lastGraceUsed: currentTime
              }
            });
            
            console.log(`[Streak Reset] User: ${plan.user.address}`);
          }
        }
      } catch (error) {
        console.error(`[Streak Update Failed] Plan: ${plan.id}`, error);
      }
    }
  } catch (error) {
    console.error("[Streak Updates Failed]", error);
  }
}

// Reward Distribution
async function distributeRewards() {
  try {
    // Get yield from Aave
    const aaveYield = await getAaveYield(AAVE_POOL, cbBTC_ADDRESS);
    
    // Create new yield pool
    const yieldPool = await prisma.yieldPool.create({
      data: {
        totalAmount: 0,
        aaveYield: aaveYield,
        penaltyAmount: 0
      }
    });
    
    // Get all users with active streaks
    const eligibleUsers = await prisma.dCAUser.findMany({
      where: {
        currentStreak: {
          gt: 0
        }
      }
    });
    
    if (eligibleUsers.length === 0) {
      console.log("[No Eligible Users for Rewards]");
      return;
    }
    
    // Calculate total pool
    const totalPool = aaveYield;
    const rewardPerUser = totalPool / eligibleUsers.length;
    
    // Distribute rewards
    for (const user of eligibleUsers) {
      await prisma.reward.create({
        data: {
          userId: user.id,
          amount: rewardPerUser,
          source: "yield",
          eligibleSince: new Date(),
          weight: 1.0 // Equal distribution for now
        }
      });
    }
    
    // Update yield pool
    await prisma.yieldPool.update({
      where: { id: yieldPool.id },
      data: {
        totalAmount: totalPool,
        distributedAt: new Date()
      }
    });
    
    console.log(`[Rewards Distributed] ${eligibleUsers.length} users`);
  } catch (error) {
    console.error("[Reward Distribution Failed]", error);
  }
}

// Event Listeners
async function listenToContractEvents() {
  // Plan Creation Event
  contract.on("PlanCreated", async (user, targetBTC, dailyAmount, timePeriod, cadence, bitmorEnabled) => {
    console.log(`[Plan Created] User: ${user}`);
    
    try {
      await prisma.dCAUser.upsert({
        where: { address: user.toLowerCase() },
        update: {
          plans: {
            create: {
              targetBTC: Number(targetBTC) / 1e18,
              dailyAmount: Number(dailyAmount) / 1e6,
              timePeriod: Number(timePeriod),
              cadence: cadence === 0 ? "daily" : "weekly",
              isActive: true,
              bitmorEnabled
            }
          }
        },
        create: {
          address: user.toLowerCase(),
          totalPaid: 0,
          btcAccumulated: 0,
          startTime: new Date(),
          lastPaymentTime: new Date(),
          currentStreak: 0,
          maxStreak: 0,
          plans: {
            create: {
              targetBTC: Number(targetBTC) / 1e18,
              dailyAmount: Number(dailyAmount) / 1e6,
              timePeriod: Number(timePeriod),
              cadence: cadence === 0 ? "daily" : "weekly",
              isActive: true,
              bitmorEnabled
            }
          }
        }
      });
    } catch (error) {
      console.error(`[Plan Creation Failed] User: ${user}`, error);
    }
  });
  
  // Payment Event
  contract.on("PaymentProcessed", async (user, usdcAmount, btcAmount, streak, usesPrepaid) => {
    console.log(`[Payment Processed] User: ${user}`);
    
    try {
      const dbUser = await prisma.dCAUser.findUnique({
        where: { address: user.toLowerCase() },
        include: { plans: { where: { isActive: true } } }
      });
      
      if (!dbUser || !dbUser.plans[0]) {
        throw new Error("User or active plan not found");
      }
      
      await prisma.dCAPayment.create({
        data: {
          planId: dbUser.plans[0].id,
          amount: Number(usdcAmount) / 1e6,
          btcAmount: Number(btcAmount) / 1e18,
          usesPrepaid,
          status: "completed",
          completedAt: new Date()
        }
      });
      
      await prisma.dCAUser.update({
        where: { id: dbUser.id },
        data: {
          totalPaid: { increment: Number(usdcAmount) / 1e6 },
          btcAccumulated: { increment: Number(btcAmount) / 1e18 },
          currentStreak: Number(streak),
          maxStreak: Math.max(dbUser.maxStreak, Number(streak)),
          lastPaymentTime: new Date()
        }
      });
    } catch (error) {
      console.error(`[Payment Processing Failed] User: ${user}`, error);
    }
  });
  
  // Early Withdrawal Event
  contract.on("EarlyWithdrawal", async (user, btcAmount, penalty, daysRemaining) => {
    console.log(`[Early Withdrawal] User: ${user}`);
    
    try {
      const dbUser = await prisma.dCAUser.findUnique({
        where: { address: user.toLowerCase() },
        include: { plans: { where: { isActive: true } } }
      });
      
      if (!dbUser || !dbUser.plans[0]) {
        throw new Error("User or active plan not found");
      }
      
      await prisma.withdrawal.create({
        data: {
          userId: dbUser.id,
          planId: dbUser.plans[0].id,
          btcAmount: Number(btcAmount) / 1e18,
          penaltyAmount: Number(penalty) / 1e18,
          status: "completed",
          completedAt: new Date()
        }
      });
      
      await prisma.dCAUser.update({
        where: { id: dbUser.id },
        data: {
          btcAccumulated: 0
        }
      });
      
      await prisma.dCAPlan.update({
        where: { id: dbUser.plans[0].id },
        data: {
          isActive: false
        }
      });
    } catch (error) {
      console.error(`[Early Withdrawal Failed] User: ${user}`, error);
    }
  });
  
  // Bitmor Threshold Event
  contract.on("BitmorThresholdReached", async (user, btcAmount, loanAmount) => {
    console.log(`[Bitmor Threshold] User: ${user}`);
    
    try {
      const dbUser = await prisma.dCAUser.findUnique({
        where: { address: user.toLowerCase() },
        include: { plans: { where: { isActive: true } } }
      });
      
      if (!dbUser || !dbUser.plans[0]) {
        throw new Error("User or active plan not found");
      }
      
      await prisma.dCAUser.update({
        where: { id: dbUser.id },
        data: {
          thresholdReached: true,
          btcAccumulated: 0
        }
      });
      
      await prisma.dCAPlan.update({
        where: { id: dbUser.plans[0].id },
        data: {
          isActive: false
        }
      });
    } catch (error) {
      console.error(`[Bitmor Threshold Failed] User: ${user}`, error);
    }
  });
  
  // Rewards Distribution Event
  contract.on("RewardsDistributed", async (user, rewardAmount, yieldBoost) => {
    console.log(`[Rewards Distributed] User: ${user}`);
    
    try {
      const dbUser = await prisma.dCAUser.findUnique({
        where: { address: user.toLowerCase() }
      });
      
      if (!dbUser) {
        throw new Error("User not found");
      }
      
      await prisma.reward.create({
        data: {
          userId: dbUser.id,
          amount: Number(rewardAmount) / 1e18,
          source: "yield",
          eligibleSince: new Date(),
          weight: 1.0,
          claimed: false
        }
      });
      
      // Track hidden yield boost
      await prisma.reward.create({
        data: {
          userId: dbUser.id,
          amount: Number(yieldBoost) / 1e18,
          source: "boost",
          eligibleSince: new Date(),
          weight: 1.0,
          claimed: false
        }
      });
    } catch (error) {
      console.error(`[Rewards Distribution Failed] User: ${user}`, error);
    }
  });
  
  // Dust Sweep Event
  contract.on("DustSwept", async (user, dustAmount, btcAmount) => {
    console.log(`[Dust Swept] User: ${user}`);
    
    try {
      const dbUser = await prisma.dCAUser.findUnique({
        where: { address: user.toLowerCase() },
        include: { plans: { where: { isActive: true } } }
      });
      
      if (!dbUser || !dbUser.plans[0]) {
        throw new Error("User or active plan not found");
      }
      
      await prisma.dustSweep.create({
        data: {
          userAddress: user.toLowerCase(),
          totalValueUSD: Number(dustAmount) / 1e6,
          status: "completed",
          completedAt: new Date()
        }
      });
      
      await prisma.dCAUser.update({
        where: { id: dbUser.id },
        data: {
          btcAccumulated: { increment: Number(btcAmount) / 1e18 }
        }
      });
    } catch (error) {
      console.error(`[Dust Sweep Failed] User: ${user}`, error);
    }
  });
}

// Main Loop
async function main() {
  console.log("Starting off-chain service...");
  
  // Update prices every 5 minutes
  setInterval(updatePrices, 5 * 60 * 1000);
  
  // Update streaks every hour
  setInterval(updateStreaks, 60 * 60 * 1000);
  
  // Distribute rewards daily
  setInterval(distributeRewards, 24 * 60 * 60 * 1000);
  
  // Start event listeners
  await listenToContractEvents();
  
  console.log("Off-chain service started successfully");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
