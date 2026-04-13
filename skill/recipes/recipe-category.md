---
name: recipe-category
description: Single-category deep dive with trend, payee breakdown, and transaction history
---

# Category Deep Dive

## Trigger
"category deep dive", "show me groceries", "drill into dining", "category report for X", "how much on X over time", "spending on X", "category analysis"

**Parameterized:** Agent must determine the target category from user request. If unclear, ask.

## Data Commands
```bash
arc query category --name 'CATEGORY_NAME' --start YYYY-MM-DD --end YYYY-MM-DD --json
arc query trends --months 6 --json
arc query spending --month YYYY-MM --json
```
Category returns: `[{ id, date, amount, payee_name, category, account, notes }]`
Trends returns: per-category monthly data — filter client-side to target category.
Spending returns: all categories for current month — compute share percentage.

Defaults: `start` = 6 months ago, `end` = today.

## Layout

1. **Arc nav bar**
2. **Header**: category name as title (DM Serif 42px) + subtitle "Category Analysis"
3. **Hero total**: sum of `|amount|/100` from all transactions. DM Serif 72px, gold `#e8c468`.
4. **Stat cards** (4-col):
   - "TOTAL SPENT" (gold): same as hero
   - "TRANSACTIONS" (teal): count of transactions
   - "AVERAGE" (blue): total / count
   - "SHARE" (purple): this category's current month spend / total monthly spend * 100, as "X.X%"
5. **Section: "MONTHLY TREND"**
   - **Bar chart**: monthly spending for this category from trends data. Filter the trends array to find the matching category, then plot its `months` array. Gold `#e8c468` bars. borderRadius 6.
6. **Section: "BY PAYEE"**
   - **Donut chart**: group transactions by `payee_name`, sum `|amount|` per payee. Top 8 payees as segments. Standard cat-1 through cat-8 palette. Center label: "N payees".
7. **Section: "TRANSACTIONS"**
   - **Table**: all transactions from query. Columns: Date | Payee | Amount | Account | Notes. Mono amounts. Sort by date desc. If >20 rows, show first 20 with a note "Showing 20 of N transactions".
8. **Footer**

## Design
- Gold `#e8c468` as primary accent (single-category view uses gold consistently)
- Payee grouping: client-side `reduce()` on transactions, keyed by `payee_name || 'Unknown'`
- Monthly trend: extract from trends data rather than re-aggregating from transactions (more reliable)

## Empty State
"No transactions found for '{category_name}' in the selected period."
