---
name: recipe-accounts
description: Account overview with net worth, balance cards, and on/off-budget grouping
---

# Account Overview

## Trigger
"account overview", "net worth", "all accounts", "account balances", "how much do I have", "total balance", "show my accounts"

## Data Commands
```bash
arc query accounts --json
arc query monthly --months 6 --json
```
Accounts returns: `[{ name, id, type, balance, offbudget, closed, currency?, fxRate?, nativeBalance? }]`
Monthly returns: `[{ month, income, expenses, net }]`

Filter: exclude closed accounts from display and totals.

## Layout

1. **Arc nav bar**
2. **Header**: "Accounts" + subtitle "Overview"
3. **Hero total**: sum of all non-closed `balance / 100` (base-currency for FX accounts). Label "NET WORTH". DM Serif 72px. Teal if positive, coral if negative.
4. **Stat cards** (3-col):
   - "ON BUDGET" (teal): sum of on-budget account balances / 100
   - "OFF BUDGET" (purple): sum of off-budget account balances / 100
   - "ACCOUNTS" (gold): count of active accounts
5. **Section: "ON-BUDGET ACCOUNTS"**
   - **Account cards** (2-col grid): for each on-budget, non-closed account:
     - Account name (Outfit 16px 600)
     - Type badge: "CHECKING" / "SAVINGS" / "CREDIT" etc. (mono 9px uppercase, surface-hover bg pill, border-radius 100px)
     - Balance: JetBrains Mono 24px 700. For FX accounts: `nativeBalance/100` + ` {currency}`. For non-FX: plain number.
     - FX sub-line (if applicable): base-currency equivalent in dim smaller text
     - Colored left border: teal for positive, coral for negative
     - Card: surface bg, border, 14px radius, 24px padding
6. **Section: "OFF-BUDGET ACCOUNTS"**
   - Same card style but purple left border instead of teal/coral
7. **Section: "NET FLOW TREND"**
   - **Line/area chart**: cumulative net from monthly data. Compute running sum of `net/100` across months. Teal line, 0.05 fill, tension 0.35. X: month labels. Y: cumulative net.
8. **Footer**

## Design
- Account type badge colors: all use text-dim on surface-hover bg (neutral). Type is informational, not color-coded.
- FX accounts: always show native currency prominently. Example: "45,230.50 INR" in large mono, then "≈ 542.77" dimmed below.
- Sort accounts alphabetically within each group.
- Net flow trend: shows how the user's financial position has changed over 6 months. Not actual net worth (which would require historical balances for all accounts), but income-minus-expenses flow.

## Empty State
If no accounts: "No accounts found. Create one with `arc accounts create`."
