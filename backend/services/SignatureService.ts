import { ethers } from "ethers";
import { generateNonce } from "../utils";

export class SignatureService {
  private readonly wallet: ethers.Wallet;
  private readonly chainId: number;

  constructor(privateKey: string, chainId: number) {
    this.wallet = new ethers.Wallet(privateKey);
    this.chainId = chainId;
  }

  /**
   * Signs plan creation parameters
   */
  async signCreatePlan(
    user: string,
    targetBTC: bigint,
    dailyAmount: bigint,
    timePeriod: number,
    withdrawalDelay: number,
    cadence: number,
    bitmorEnabled: boolean
  ): Promise<{ nonce: string; signature: string }> {
    const nonce = generateNonce();
    const messageHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint128", "uint128", "uint32", "uint32", "uint8", "bool", "bytes32", "uint256"],
        [user, targetBTC, dailyAmount, timePeriod, withdrawalDelay, cadence, bitmorEnabled, nonce, this.chainId]
      )
    );
    const signature = await this.wallet.signMessage(ethers.getBytes(messageHash));
    return { nonce, signature };
  }

  /**
   * Signs payment parameters
   */
  async signPayment(
    user: string,
    usdcAmount: bigint,
    btcAmount: bigint,
    usesPrepaid: boolean
  ): Promise<{ nonce: string; signature: string }> {
    const nonce = generateNonce();
    const messageHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint128", "uint128", "bool", "bytes32", "uint256"],
        [user, usdcAmount, btcAmount, usesPrepaid, nonce, this.chainId]
      )
    );
    const signature = await this.wallet.signMessage(ethers.getBytes(messageHash));
    return { nonce, signature };
  }

  /**
   * Signs prepay days parameters
   */
  async signPrepayDays(
    user: string,
    usdcAmount: bigint,
    days: number
  ): Promise<{ nonce: string; signature: string }> {
    const nonce = generateNonce();
    const messageHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint128", "uint32", "bytes32", "uint256"],
        [user, usdcAmount, days, nonce, this.chainId]
      )
    );
    const signature = await this.wallet.signMessage(ethers.getBytes(messageHash));
    return { nonce, signature };
  }

  /**
   * Signs early withdrawal parameters
   */
  async signEarlyWithdrawal(
    user: string,
    btcAmount: bigint,
    penaltyAmount: bigint,
    daysRemaining: number
  ): Promise<{ nonce: string; signature: string }> {
    const nonce = generateNonce();
    const messageHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint128", "uint128", "uint32", "bytes32", "uint256"],
        [user, btcAmount, penaltyAmount, daysRemaining, nonce, this.chainId]
      )
    );
    const signature = await this.wallet.signMessage(ethers.getBytes(messageHash));
    return { nonce, signature };
  }

  /**
   * Signs plan completion
   */
  async signCompletePlan(user: string): Promise<{ nonce: string; signature: string }> {
    const nonce = generateNonce();
    const messageHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "string", "bytes32", "uint256"],
        [user, "COMPLETE", nonce, this.chainId]
      )
    );
    const signature = await this.wallet.signMessage(ethers.getBytes(messageHash));
    return { nonce, signature };
  }

  /**
   * Signs reward distribution parameters
   */
  async signRewardDistribution(
    users: string[],
    amounts: bigint[],
    boosts: bigint[]
  ): Promise<{ nonce: string; signature: string }> {
    const nonce = generateNonce();
    const messageHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address[]", "uint128[]", "uint128[]", "bytes32", "uint256"],
        [users, amounts, boosts, nonce, this.chainId]
      )
    );
    const signature = await this.wallet.signMessage(ethers.getBytes(messageHash));
    return { nonce, signature };
  }

  /**
   * Signs dust sweep parameters
   */
  async signDustSweep(
    user: string,
    tokenAmounts: bigint[],
    tokens: string[],
    expectedBTC: bigint
  ): Promise<{ nonce: string; signature: string }> {
    const nonce = generateNonce();
    const messageHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint128[]", "address[]", "uint128", "bytes32", "uint256"],
        [user, tokenAmounts, tokens, expectedBTC, nonce, this.chainId]
      )
    );
    const signature = await this.wallet.signMessage(ethers.getBytes(messageHash));
    return { nonce, signature };
  }

  /**
   * Signs Bitmor threshold parameters
   */
  async signBitmorThreshold(
    user: string,
    btcAmount: bigint
  ): Promise<{ nonce: string; signature: string }> {
    const nonce = generateNonce();
    const messageHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint128", "string", "bytes32", "uint256"],
        [user, btcAmount, "BITMOR_THRESHOLD", nonce, this.chainId]
      )
    );
    const signature = await this.wallet.signMessage(ethers.getBytes(messageHash));
    return { nonce, signature };
  }

  /**
   * Verifies a signature
   */
  verifySignature(
    message: string,
    signature: string,
    expectedSigner: string
  ): boolean {
    try {
      const recoveredAddress = ethers.verifyMessage(
        ethers.getBytes(message),
        signature
      );
      return recoveredAddress.toLowerCase() === expectedSigner.toLowerCase();
    } catch (error) {
      return false;
    }
  }
}
