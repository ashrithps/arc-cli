---
name: recipe-payees
description: Payee/merchant analysis with top payees, spending breakdown, and frequency
---

# Payee Analysis

## Trigger
"payee analysis", "where does my money go", "spending by merchant", "top payees", "who do I pay most", "merchant breakdown"

## Data Commands
```bash
arc payees common --limit 15 --json
# Then for each of top 10 payees:
arc query payee --name 'PAYEE_NAME' --limit 20 --json
# For context:
arc query spending --month YYYY-MM --json
```
Common returns: `[{ id, name, count }]`
Payee query returns: transaction array `[{ id, date, amount, payee_name, category, account, notes }]`

**Note:** Agent must loop through top 10 payees. Exclude transfer payees (payees matching account names).

## Layout

1. **Arc nav bar**
2. **Header**: "Payees" + subtitle "Merchant Analysis"
3. **Stat cards** (3-col):
   - "TOP PAYEE" (gold): name of #1 payee + their total spend
   - "UNIQUE PAYEES" (teal): count from common list
   - "TRANSACTIONS" (purple): sum of all counts
4. **Section: "TOP PAYEES"**
   - **Horizontal bar chart**: top 15 payees by transaction count. Payee names as y-axis labels. Bars cycle through cat-1 to cat-9 colors. indexAxis 'y'. borderRadius 4.
5. **Section: "SPENDING BY PAYEE"**
   - **Payee cards** (2-col grid): for each top-10 payee:
     - Payee name (Outfit 16px 600)
     - Transaction count badge (mono 10px, surface-hover bg pill)
     - Total spent: sum of |amount|/100 from that payee's transactions (JetBrains Mono 20px 700)
     - Avg per transaction (mono 12px dim): total / count
     - Last transaction date (11px dim)
     - Colored left border cycling cat-1 through cat-9
6. **Section: "RECENT ACTIVITY"**
   - **Table**: combined recent transactions from top 5 payees, sorted by date desc. Columns: Date | Payee | Amount | Category | Account. Mono amounts (coral for expenses). Limit 25 rows.
7. **Footer**

## Design
- Horizontal bar chart: good for long payee names. Bar height 24px, gap 8px.
- Payee cards: similar to category cards but 2-column (payee names are longer)
- Total per payee: computed client-side by summing transaction amounts

## Empty State
If no payees or no transactions: "No payee data found."
