# BitmorDCA Documentation

## Smart Contract Documentation

The BitmorDCA smart contract (`contract/src/BitmorDCA.sol`) provides the core functionality for Dollar Cost Averaging (DCA) in cryptocurrency investments.

### Contract Features

1. **Plan Management**
   - `createDCAplan`: Create a new DCA investment plan
   - `makePayment`: Process a DCA payment
   - `prepayDays`: Prepay for future DCA payments
   - `earlyWithdraw`: Withdraw funds before plan completion (with penalty)
   - `completePlan`: Complete a DCA plan and withdraw funds

2. **Rewards System**
   - `distributeRewards`: Distribute rewards to users
   - `claimRewards`: Claim accumulated rewards
   - `sweepDust`: Convert small token balances to BTC

3. **Integration Points**
   - Aave Pool for yield generation
   - Uniswap V2 for token swaps
   - Backend signer for off-chain calculations

### Contract States

1. **User Plan States**
   ```solidity
   enum PlanStatus { INACTIVE, ACTIVE, PAUSED, COMPLETED, EARLY_EXIT }
   enum Cadence { DAILY, WEEKLY }
   ```

2. **Core Data Structures**
   ```solidity
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
   ```

## Backend API Documentation

The backend service (`backend/index.js`) provides RESTful APIs for interacting with the BitmorDCA platform.

### API Endpoints

#### 1. Token Management

##### Get Supported Tokens
```http
GET /api/tokens/supported
```
**Response:**
```json
{
    "tokens": [
        {
            "id": "token-id",
            "symbol": "USDC",
            "name": "USD Coin",
            "address": "0x...",
            "decimals": 6,
            "isStablecoin": true,
            "minAmount": 10,
            "maxAmount": 10000
        }
    ]
}
```

##### Get User Token Balances
```http
GET /api/users/:address/token-balances
```
**Response:**
```json
{
    "balances": [
        {
            "token": {
                "id": "token-id",
                "symbol": "USDC",
                "name": "USD Coin",
                "address": "0x...",
                "decimals": 6
            },
            "balance": "1000.0",
            "raw": "1000000000"
        }
    ]
}
```

#### 2. Plan Management

##### Create Plan
```http
POST /api/plans/create
```
**Body:**
```json
{
    "userAddress": "0x...",
    "targetBTC": "1.0",
    "timePeriodDays": 365,
    "withdrawalDelayDays": 7,
    "penaltyMin": 100,
    "penaltyMax": 5000,
    "cadence": "daily",
    "bitmorIntegration": true,
    "tokens": [
        {
            "tokenId": "token-id-1",
            "weight": 60
        },
        {
            "tokenId": "token-id-2",
            "weight": 40
        }
    ]
}
```
**Notes:**
- The `tokens` array specifies which tokens to use for DCA and their relative weights
- Weights must sum to 100%
- Each token must be a supported token (fetch from `/api/tokens/supported`)
- The daily amount for each token is calculated based on its weight

##### Calculate Payment
```http
POST /api/payments/calculate
```
**Body:**
```json
{
    "userAddress": "0x..."
}
```

#### 2. Early Withdrawal

##### Calculate Penalty
```http
POST /api/penalties/calculate
```
**Body:**
```json
{
    "userAddress": "0x...",
    "planId": "123"
}
```

#### 3. Strategy Management

##### Create Strategy
```http
POST /api/strategies/create
```
**Body:**
```json
{
    "creatorAddress": "0x...",
    "name": "Conservative BTC",
    "targetBTC": "0.5",
    "timePeriodDays": 180,
    "withdrawalDelayDays": 14,
    "penaltyMin": 200,
    "penaltyMax": 4000,
    "cadence": "weekly"
}
```

#### 4. Bitmor Integration

##### Check Threshold
```http
POST /api/bitmor/check-threshold
```
**Body:**
```json
{
    "userAddress": "0x...",
    "planId": "123"
}
```

#### 5. Analytics

##### Get Plan Analytics
```http
GET /api/plans/:userAddress/analytics
```

#### 6. Rewards

##### Distribute Rewards
```http
POST /api/rewards/distribute
```

##### Calculate Dust Sweep
```http
POST /api/dust/calculate
```
**Body:**
```json
{
    "userAddress": "0x..."
}
```

#### 7. Plan Completion

##### Verify Plan Completion
```http
POST /api/plans/verify-completion
```
**Body:**
```json
{
    "userAddress": "0x...",
    "planId": "123"
}
```

#### 8. User Balance and Stats

##### Get User Balance
```http
GET /api/users/:address/balance
```
**Response:**
```json
{
    "cbBTCBalance": "0.5",
    "totalBTCAccumulated": 1.2,
    "totalWithdrawn": 0.7,
    "totalDeposited": 1.5,
    "totalPenaltyPaid": 50.0,
    "currentBalance": 0.5
}
```

##### Get Early Withdrawal Fee
```http
GET /api/plans/:planId/withdrawal-fee
```
**Response:**
```json
{
    "fee": 100.0,
    "daysRemaining": 30,
    "penaltyPercentage": 5.0,
    "totalValueLocked": 2000.0,
    "progress": 75.0
}
```

##### Get User Referrals
```http
GET /api/users/:address/referral
```
**Response:**
```json
{
    "referralCode": "abc123",
    "referralLink": "https://app.bitmordca.com/register?ref=abc123",
    "totalReferrals": 5,
    "activeReferrals": 3,
    "totalRewards": 100.0,
    "referrals": [
        {
            "address": "0x...",
            "status": "active",
            "rewardAmount": 20.0,
            "joinedAt": "2024-03-20T12:00:00Z"
        }
    ]
}
```

##### Use Referral Code
```http
POST /api/referral/use
```
**Body:**
```json
{
    "userAddress": "0x...",
    "referralCode": "abc123"
}
```

##### Get User Statistics
```http
GET /api/users/:address/stats
```
**Response:**
```json
{
    "address": "0x...",
    "startTime": "2024-01-01T00:00:00Z",
    "currentStreak": 30,
    "maxStreak": 45,
    "statistics": {
        "totalDCAExecuted": 5000.0,
        "dustSweepEarnings": 100.0,
        "totalPenalties": 50.0,
        "totalRewards": 200.0,
        "totalBTCAccumulated": 1.5,
        "totalDeposited": 6000.0,
        "totalWithdrawn": 4000.0
    },
    "referralStats": {
        "totalReferrals": 5,
        "activeReferrals": 3,
        "totalRewards": 100.0
    },
    "activePlans": 2,
    "completedPlans": 1
}
```

#### 9. System Status

##### Health Check
```http
GET /api/health
```

### Automated Tasks (Cron Jobs)

1. **Price Updates** (Every 5 minutes)
   - Updates BTC price from Chainlink
   - Maintains price history

2. **Payment Monitoring** (Hourly)
   - Checks for missed payments
   - Updates user streaks

3. **Reward Distribution** (Every 6 hours)
   - Calculates eligible users
   - Distributes rewards based on streaks and commitment

4. **Maintenance** (Daily)
   - Cleans up old price history
   - Updates plan streaks
   - Performs Redis cache cleanup

### Error Handling

All API endpoints follow a consistent error response format:
```json
{
    "success": false,
    "error": "Error message",
    "details": "Additional error details (in development)",
    "requestId": "unique-request-id"
}
```

### Rate Limiting

- 100 requests per IP per 15 minutes
- Applies to all `/api/` endpoints

### Security Features

1. **Backend Signing**
   - All contract interactions require backend signatures
   - Prevents unauthorized transactions

2. **Nonce Management**
   - Each transaction uses a unique nonce
   - Prevents replay attacks

3. **Input Validation**
   - Strict validation for all API inputs
   - Address validation
   - Amount and time period constraints

### Data Persistence

1. **Database (Prisma)**
   - User data
   - Plan details
   - Payment history
   - Price history
   - Error logs

2. **Redis Cache**
   - BTC price caching
   - Transaction nonces
   - Temporary calculation results
   - Rate limiting
