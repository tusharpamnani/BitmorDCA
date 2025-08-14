### 🎯 Goal-Setting Rules

**1. \[goal.set]**
User can set a **BTC target amount**, **DCA cadence** (`daily` or `weekly`), and a **completion period** (e.g., 6 months).
→ System auto-calculates required payment amount using **current BTC price**.
→ Display **educational warning**:

> “Note: Amount is indicative based on current BTC price. Actual BTC acquired may vary due to price changes during the period.”

---

### 🔐 Commitment & Withdrawal Rules

**2. \[withdrawal.commitment]**
User must set a **withdrawal time delay** (min `7 days`).
→ Presets: `7d`, `30d`, `60d`, `90d`
→ Default: `30d`

**3. \[withdrawal.penalty]**
User sets `p_min` (default `1%`) and `p_max` (default `5%`)
→ Penalty is **time-decay based**:

```plaintext
penalty_pct = p_min + (p_max − p_min) * (frac_left^1.5)
frac_left = time remaining / total time period
```

---

### 🔄 Streak & Grace Rules

**4. \[streak.tracking]**
Missed scheduled payment → **streak ends**
→ Grace window to restart:

* `daily` cadence → 7 days
* `weekly` cadence → 3 weeks
  → After grace, early-exit penalties apply
  → On restart: streak resets to `0`

---

### 💳 Prepayment Rules

**5. \[prepay.allow]**
User can **prepay** for future DCA periods
→ Deductions are paused until prepay duration ends
→ System tracks prepay coverage window

---

### 🔼 Increase Plan Contribution

**6. \[plan.increase]**
User can **increase DCA amount** anytime
→ Triggers immediate update to:

* Remaining schedule
* Target completion forecast
* Reward weightings

---

### 💡 Sweep "Dust" Balance

**7. \[dust.sweep]**
User can opt-in to **sweep small coin balances** (`$value < x`) into BTC
→ Notify user:

> “You have \$x in idle assets. Convert to BTC and fund y days of DCA?”
> → Include action CTA

---

### 🏆 Rewards System

**8. \[rewards.distribute]**
Daily rewards distributed from:

* Early withdrawal penalties
* Yield-generated pool

→ Distribution weighted by:

* `streak length` or `completion %`
* `total committed value`
* `p_max` value (higher = more reward)

→ Rewards added to user’s DCA BTC balance on **milestone streaks**

---

### ✨ Surprise Yield Boost

**9. \[yield.boost.hidden]**
All BTC is moved to yield platform (`Moonwell` or `Aave` — whichever has higher APY)
→ **Not shown to user**
→ Surprise “Boost” notifications (e.g.,

> “Surprise! You earned extra BTC yield for staying committed!”)

