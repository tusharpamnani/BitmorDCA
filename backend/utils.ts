import { ethers } from "ethers";
import axios from "axios";

// ABIs
const UNISWAP_ROUTER_ABI = require("./abis/UniswapRouter.json");
const AAVE_POOL_ABI = require("./abis/AavePool.json");
const ERC20_ABI = require("./abis/ERC20.json");

// Constants
const COINGECKO_API = "https://api.coingecko.com/api/v3";

/**
 * Fetches current price from CoinGecko
 */
export async function fetchPrice(asset: string): Promise<number> {
  try {
    const response = await axios.get(
      `${COINGECKO_API}/simple/price?ids=${asset}&vs_currencies=usd`
    );
    return response.data[asset]?.usd || 0;
  } catch (error) {
    console.error("Error fetching price:", error);
    throw error;
  }
}

/**
 * Swaps tokens to WBTC via Uniswap
 */
export async function swapToCbBTC(
  tokens: { token: string; amount: string }[],
  routerAddress: string,
  cbBTCAddress: string
): Promise<ethers.TransactionResponse> {
  try {
    // Initialize router contract
    const router = new ethers.Contract(
      routerAddress,
      UNISWAP_ROUTER_ABI,
      provider
    );
    
    // Build swap path for each token
    const swaps = tokens.map(({ token, amount }) => ({
      path: [token, cbBTCAddress],
      amountIn: amount,
      amountOutMin: 0 // TODO: Add slippage protection
    }));
    
    // Execute batch swap
    const tx = await router.swapExactTokensForTokens(
      swaps,
      0, // amountOutMin
      Date.now() + 1800, // deadline: 30 minutes
      { gasLimit: 500000 }
    );
    
    return tx;
  } catch (error) {
    console.error("Error swapping to cbBTC:", error);
    throw error;
  }
}

/**
 * Deposits cbBTC to Aave
 */
export async function depositToAave(
  amount: bigint,
  poolAddress: string,
  cbBTCAddress: string
): Promise<ethers.TransactionResponse> {
  try {
    // Initialize Aave pool contract
    const pool = new ethers.Contract(poolAddress, AAVE_POOL_ABI, provider);
    
    // Supply to Aave
    const tx = await pool.supply(
      cbBTCAddress,
      amount,
      { gasLimit: 300000 }
    );
    
    return tx;
  } catch (error) {
    console.error("Error depositing to Aave:", error);
    throw error;
  }
}

/**
 * Withdraws cbBTC from Aave
 */
export async function withdrawFromAave(
  amount: bigint,
  poolAddress: string,
  cbBTCAddress: string
): Promise<ethers.TransactionResponse> {
  try {
    // Initialize Aave pool contract
    const pool = new ethers.Contract(poolAddress, AAVE_POOL_ABI, provider);
    
    // Withdraw from Aave
    const tx = await pool.withdraw(
      cbBTCAddress,
      amount,
      { gasLimit: 300000 }
    );
    
    return tx;
  } catch (error) {
    console.error("Error withdrawing from Aave:", error);
    throw error;
  }
}

/**
 * Gets current yield from Aave
 */
export async function getAaveYield(
  poolAddress: string,
  cbBTCAddress: string
): Promise<number> {
  try {
    // Initialize Aave pool contract
    const pool = new ethers.Contract(poolAddress, AAVE_POOL_ABI, provider);
    
    // Get reserve data
    const reserveData = await pool.getReserveData(wbtcAddress);
    
    // Calculate yield
    const liquidityRate = reserveData.currentLiquidityRate;
    const yield = Number(liquidityRate) / 1e27; // Convert from RAY to decimal
    
    return yield;
  } catch (error) {
    console.error("Error getting Aave yield:", error);
    throw error;
  }
}

/**
 * Calculates penalty for early withdrawal
 */
export function calculatePenalty(
  startTime: number,
  endTime: number,
  currentTime: number,
  penaltyMin: number,
  penaltyMax: number,
  penaltyExponent: number = 1.5
): number {
  // If past end time, return min penalty
  if (currentTime >= endTime) return penaltyMin;
  
  // Calculate fraction of time remaining
  const totalTime = endTime - startTime;
  const timeRemaining = endTime - currentTime;
  const fracLeft = timeRemaining / totalTime;
  
  // Apply exponential decay
  const fracLeftPowered = Math.pow(fracLeft, penaltyExponent);
  
  // Calculate penalty
  const penalty = penaltyMin + ((penaltyMax - penaltyMin) * fracLeftPowered);
  
  return Math.floor(penalty);
}

/**
 * Validates and formats a wallet address
 */
export function validateAddress(address: string): string {
  try {
    return ethers.getAddress(address);
  } catch (error) {
    throw new Error("Invalid Ethereum address");
  }
}

/**
 * Formats a number to a fixed number of decimals
 */
export function formatNumber(
  number: number | string,
  decimals: number = 18
): string {
  try {
    return ethers.formatUnits(number.toString(), decimals);
  } catch (error) {
    throw new Error("Invalid number format");
  }
}

/**
 * Parses a number from a string with decimals
 */
export function parseNumber(
  number: string,
  decimals: number = 18
): bigint {
  try {
    return ethers.parseUnits(number, decimals);
  } catch (error) {
    throw new Error("Invalid number format");
  }
}

/**
 * Generates a unique nonce
 */
export function generateNonce(): string {
  return ethers.id(Date.now().toString() + Math.random().toString());
}

/**
 * Signs a message with a private key
 */
export async function signMessage(
  message: string,
  privateKey: string
): Promise<string> {
  try {
    const wallet = new ethers.Wallet(privateKey);
    return await wallet.signMessage(ethers.getBytes(message));
  } catch (error) {
    throw new Error("Error signing message");
  }
}

/**
 * Verifies a signature
 */
export function verifySignature(
  message: string,
  signature: string,
  address: string
): boolean {
  try {
    const recoveredAddress = ethers.verifyMessage(
      ethers.getBytes(message),
      signature
    );
    return recoveredAddress.toLowerCase() === address.toLowerCase();
  } catch (error) {
    return false;
  }
}