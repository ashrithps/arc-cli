---
name: recipe-budget
description: Budget vs actual spending with adherence indicators per category
---

# Budget vs Actual

## Trigger
"budget vs actual", "am I on budget", "budget performance", "budget tracker", "budget report", "over budget", "how am I doing against my budget"

## Data Commands
```bash
arc budgets month --month YYYY-MM --json
arc budgets summary --month YYYY-MM --json
arc budgets income --month YYYY-MM --json
```
Budget month returns: `{ month, categoryGroups: [{ name, budgeted, spent, balance, categories: [{ name, budgeted, spent, balance, carryover }] }] }`
Summary returns: `{ totalBudgeted, totalSpent, totalBalance, toBudget }`
Income returns: `{ totalReceived, totalBudgeted, categories }`

**Important:** If `totalBudgeted === 0`, the user hasn't set budget amounts. Show a notice: "No budgeted amounts found for {month}. Set budgets with `arc budgets set-amount` or try the Spending dashboard instead." and stop.

## Layout

1. **Arc nav bar**
2. **Header**: "Budget" + month subtitle
3. **Hero total**: `toBudget / 100` — amount left to allocate. Teal if positive (healthy), coral if negative (over-allocated). DM Serif 72px.
4. **Stat cards** (4-col):
   - "BUDGETED" (gold): `totalBudgeted / 100`
   - "SPENT" (red): `|totalSpent| / 100`
   - "REMAINING" (teal): `totalBalance / 100`
   - "INCOME" (blue): `totalReceived / 100`
5. **Section: "BUDGET ADHERENCE"**
   - **Horizontal bar chart**: each category as a row. For each: background bar = budgeted (full width), foreground bar = |spent|. Color by utilization: teal <80%, gold 80-100%, coral >100%. Labels: category name left, spent/budgeted right. Sort by utilization ratio descending.
6. **Section: "BY CATEGORY"**
   - **Category cards** (3-col): for each category where budgeted > 0:
     - Name (Outfit 13px 500)
     - Progress bar: `|spent| / budgeted` ratio. Fill color: teal <80%, gold 80-100%, coral >100%. If >100%, bar extends with overflow visible + red glow.
     - Two values side by side: "Spent: X.XX" (mono) / "Budget: X.XX" (mono dim)
     - Remaining: small dim text below
     - Badge: "ON TRACK" (teal pill), "CLOSE" (gold pill), or "OVER" (red pill)
     - Sort by utilization ratio descending (worst performers first)
7. **Section: "UNBUDGETED SPENDING"**
   - **Table**: categories where `budgeted === 0` AND `spent !== 0`. Columns: Category | Amount Spent. Amber left border on table wrapper. Warning note explaining these have no budget set.
8. **Footer**

## Design
- Badge thresholds: ON TRACK = utilization < 80%, CLOSE = 80-100%, OVER = >100%
- Progress bar that exceeds 100%: cap visual at 110% width, add subtle red box-shadow glow
- Unbudgeted table: amber/gold accent (`#e8c468`) border and header color

## Empty State
See "Important" note above — redirect to spending dashboard if no budgets set.
