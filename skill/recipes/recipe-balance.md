---
name: recipe-balance
description: Account balance history with daily line chart and monthly snapshots
---

# Balance History

## Trigger
"balance history", "account balance over time", "balance trend", "how has my account changed", "account history", "balance chart"

**Parameterized:** Agent must determine which account. If unclear, ask or use the first/primary account.

## Data Commands
```bash
arc query balance-history --account 'ACCOUNT_NAME' --months 6 --json
arc query monthly-balances --account 'ACCOUNT_NAME' --months 6 --json
arc accounts list --json
```
Balance history: `[{ date, balance, dailyChange }]` — daily entries with running balance.
Monthly balances: `[{ month, balance, change }]` — end-of-month snapshots.
Accounts list: to get account metadata (type, currency, FX).

## Layout

1. **Arc nav bar**
2. **Header**: account name as title + subtitle "Balance History"
3. **Hero total**: current balance (last entry in balance-history). DM Serif 72px. Teal if positive, coral if negative. For FX accounts: show in native currency + code.
4. **Stat cards** (3-col):
   - "CURRENT" (teal): current balance
   - "HIGHEST" (gold): max balance in period
   - "LOWEST" (red): min balance in period
5. **Section: "DAILY BALANCE"**
   - **Line/area chart**: X = dates, Y = balance/100. Teal `#4ecdc4` line, 2px stroke, 0.05 fill, tension 0.35. **pointRadius 0** (too many points for dots), pointHoverRadius 4. Grid color `#111820`.
6. **Section: "MONTHLY SNAPSHOTS"**
   - **Bar chart**: one bar per month from monthly-balances. Y = balance/100. Teal for positive, coral for negative. borderRadius 6.
7. **Section: "MONTHLY CHANGES"**
   - **Table**: Columns: Month | End Balance | Change | Change %. Balance in mono. Change: teal if positive "+X.XX", coral if negative "-X.XX". Change %: `(change / prev_balance) * 100`. Inline bar for change column (proportional to max |change|).
8. **Footer**

## Design
- FX accounts: display ALL amounts in native currency with currency code. Example: "45,230.50 INR".
- Daily line chart: may have 100+ points. Keep pointRadius 0 for clean lines. Show values on hover via tooltip.
- If account has very few data points (<10), set pointRadius 3 to make points visible.

## Empty State
"No balance history found for '{account_name}'."
