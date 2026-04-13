---
name: recipe-uncategorized
description: Data quality dashboard highlighting uncategorized transactions needing attention
---

# Data Quality

## Trigger
"uncategorized transactions", "data quality", "fix my categories", "what needs categorizing", "cleanup", "categorization report", "missing categories"

## Data Commands
```bash
arc query uncategorized --json
arc accounts list --json
```
Uncategorized returns: `[{ id, account, date, amount, payee_name, imported_payee, notes }]`
Accounts: for mapping account IDs to names.

## Layout

1. **Arc nav bar**
2. **Header**: "Data Quality" + subtitle "Uncategorized Transactions"
3. **Hero total**: count of uncategorized transactions (integer, no decimals). DM Serif 72px, amber `#e8c468`. Label "UNCATEGORIZED".
4. **Stat cards** (3-col):
   - "UNCATEGORIZED" (amber): count
   - "TOTAL AMOUNT" (red): sum of |amount|/100
   - "ACCOUNTS" (teal): count of distinct accounts with uncategorized txns
5. **Section: "BY ACCOUNT"**
   - **Account cards** (2-col grid): group transactions by account. Each card:
     - Account name (Outfit 14px 500)
     - Count badge (mono 10px, surface-hover bg pill)
     - Total uncategorized amount (mono 18px)
     - Amber `#e8c468` left border (3px)
6. **Section: "BY PAYEE"**
   - **Horizontal bar chart**: group uncategorized by `payee_name || imported_payee || 'Unknown'`. Top 10 payees by count. Amber bars `rgba(232,196,104,0.6)` border `#e8c468`. indexAxis 'y'.
7. **Section: "ALL UNCATEGORIZED"**
   - **Table**: full list. Columns: Date | Account | Payee | Amount | Notes. Sorted by date desc. Mono amounts (coral for negative). Hover highlight.
8. **Section: "QUICK FIX"**
   - **Info card** (surface bg, 2px amber top border, 24px padding):
     - Heading: "Batch Categorize" (Outfit 14px 600)
     - Text: "Use arc to categorize matching transactions in bulk:"
     - For top 3 payee patterns from the by-payee data, show example commands:
       ```
       arc transactions batch-categorize --account 'ACCT' --payee 'PAYEE' --category 'CAT'
       ```
     - Styled as code blocks (mono 11px, surface-hover bg, 8px padding, 6px radius)
9. **Footer**

## Design
- **Amber/gold `#e8c468` is the primary accent** throughout — this is a warning/attention theme, not error.
- If zero uncategorized: show **success state** instead of the normal layout:
  - Large teal SVG checkmark (40px, strokeWidth 3, animated draw-on)
  - "All transactions categorized" (DM Serif 28px, teal)
  - No stat cards, tables, or charts needed.
- Payee grouping key: `payee_name || imported_payee || 'Unknown'`
- Quick Fix section makes this dashboard actionable, not just informational.

## Empty State
See success state above (zero uncategorized = good).
