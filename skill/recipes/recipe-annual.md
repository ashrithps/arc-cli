---
name: recipe-annual
description: Full-year financial summary with 12-month trends, quarterly breakdown, and top categories
---

# Annual Summary

## Trigger
"yearly summary", "annual report", "year in review", "2025 summary", "full year overview", "yearly dashboard", "end of year report"

## Data Commands
```bash
arc query monthly --months 12 --json
arc query trends --months 12 --json
arc query accounts --json
```
Monthly: 12 months of `{ month, income, expenses, net }`.
Trends: per-category spending across 12 months.
Accounts: current net worth for context.

To get annual top categories: sum each category's `|spent|` across all 12 months from trends data, then rank. No need for 12 separate `query top` calls.

## Layout

1. **Arc nav bar**
2. **Header**: "Year in Review" + subtitle year (e.g., "2025"). DM Serif 48px.
3. **Hero total**: sum of all |expenses|/100 across 12 months. DM Serif 72px, coral. Label "TOTAL EXPENSES".
4. **Stat cards** (4-col):
   - "TOTAL INCOME" (teal): sum of income/100
   - "TOTAL EXPENSES" (red): sum of |expenses|/100
   - "NET SAVED" (gold): sum of net/100
   - "AVG MONTHLY" (blue): total expenses / 12
5. **Section: "MONTHLY OVERVIEW"**
   - **Grouped bar chart**: 12 bar groups, each with 2 bars — income (teal, `rgba(78,205,196,0.6)`) and expenses (coral, `rgba(255,107,107,0.55)`). X: month abbreviations. borderRadius 4.
6. **Section: "NET SAVINGS"**
   - **Bar chart**: 12 bars for monthly net. Positive teal, negative coral. borderRadius 5.
7. **Section: "QUARTERLY BREAKDOWN"**
   - **4 stat cards** in a row, one per quarter:
     - Q1 (Jan-Mar), Q2 (Apr-Jun), Q3 (Jul-Sep), Q4 (Oct-Dec)
     - Each shows: total expenses, total income, net. Computed by summing the relevant months.
     - Top accent colors: Q1 blue, Q2 teal, Q3 gold, Q4 purple.
8. **Section: "TOP CATEGORIES"**
   - **Donut chart**: top 10 categories by annual spend (computed from trends). Standard cat-1 through cat-9 palette. 68% cutout.
9. **Section: "CATEGORY DETAIL"**
   - **Table**: all categories with nonzero spend. Columns: Category | Annual Spent | Avg Monthly | Peak Month | % of Total. Sort by annual spent desc. Mono amounts.
     - Peak Month: month abbreviation where that category's |spent| was highest.
     - % of Total: `category_annual / total_annual * 100`.
10. **Section: "CATEGORY HEATMAP"**
    - **Heatmap**: top 12 categories × 12 months. Same 5-level color scale as recipe-trends. Wider layout — add `overflow-x: auto` for mobile.
11. **Footer**

## Design
- Quarterly stat cards: each quarter gets a distinctive accent (blue, teal, gold, purple)
- Peak month column: just the 3-letter month abbreviation (e.g., "Dec")
- If requesting a specific year (e.g., "2025"), compute `--months` to cover exactly that calendar year
- Heatmap: 12 columns is wide. On mobile (<900px), enable horizontal scroll.

## Empty State
"No data available for the requested year."
