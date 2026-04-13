---
name: recipe-income
description: Income report with sources, trends, and budget vs received
---

# Income Report

## Trigger
"income report", "income dashboard", "how much did I earn", "income breakdown", "salary", "earnings", "income this month"

## Data Commands
```bash
arc budgets income --month YYYY-MM --json
arc budgets income --month PREV_MONTH --json
arc query monthly --months 6 --json
```
Income returns: `{ totalReceived, totalBudgeted, categories: [{ id, name, budgeted, received }] }`
Monthly returns: `[{ month, income, expenses, net }]`

Note: `totalReceived` is from `budget.totalIncome`. Individual category `received` is computed from transactions.

## Layout

1. **Arc nav bar**
2. **Header**: "Income" + month subtitle
3. **Hero total**: `totalReceived / 100`. DM Serif 72px, **teal** `#4ecdc4`. Count-up animation.
4. **Stat cards** (4-col):
   - "RECEIVED" (teal): totalReceived / 100
   - "BUDGETED" (gold): totalBudgeted / 100
   - "LAST MONTH" (blue #5f9df7): previous month's totalReceived / 100
   - "CHANGE" (green if up, red if down): percentage change `((current - prev) / |prev|) * 100`. Show as "+12.5%" or "-8.3%"
5. **Section: "INCOME SOURCES"**
   - **Donut chart**: one segment per income category from `categories`. **Cool palette only**: `#4ecdc4`, `#68c4e8`, `#5f9df7`, `#68e8a4`, `#a78bfa`. Center label: total received. 68% cutout.
6. **Section: "BY SOURCE"**
   - **Category cards** (3-col): per income category:
     - Category name
     - Received amount (mono 20px, teal)
     - Budgeted amount (mono 12px dim)
     - Progress bar: `received / budgeted` ratio, teal fill
     - 3px teal left border
7. **Section: "INCOME TREND"**
   - **Line/area chart**: income values from monthly data over 6 months. Teal `#4ecdc4` line, 2px stroke, 0.05 fill, tension 0.35. X: month labels. Y: income/100.
8. **Footer**

## Design
- **NEVER use red/warm colors for income.** This is a positive dashboard — all accents are cool tones: teal, blue, sky, green.
- Change stat: green `#5de88a` if positive, coral `#e85d5d` if negative. Prefix with + or -.
- If no income data (`totalReceived === 0` and `totalBudgeted === 0`): show empty state.

## Empty State
"No income recorded for {month}."
