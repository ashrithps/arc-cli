---
name: recipe-trends
description: Month-on-month spending trends with income vs expense comparison
---

# Month-on-Month Trends

## Trigger
"spending trends", "month over month", "income vs expenses", "monthly trends", "financial trends", "how are my expenses trending"

## Data Commands
```bash
arc query monthly --months 6 --json
arc query trends --months 6 --json
```
Monthly returns: `[{ month, income, expenses, net }]` (all integers, divide by 100).
Trends returns: `[{ category, months: [{ month, spent }] }]`.

## Layout

1. **Arc nav bar**
2. **Header**: eyebrow "FINANCIAL OVERVIEW" (mono 10px, accent teal), title "Month on **Month**" (DM Serif 48px, bold on second word), subtitle "Last 6 months" (14px dim)
3. **Stat cards row** (4-col grid, 16px gap):
   - "TOTAL EXPENSES" (red accent top): sum of |expenses|/100 across all months
   - "MONTHLY AVERAGE" (teal accent top): total / month count
   - "HIGHEST MONTH" (gold accent top): max |expenses|/100, subtitle = month name
   - "LOWEST MONTH" (purple accent top): min |expenses|/100, subtitle = month name
   - Values: DM Serif 32px 600, -1px letter-spacing. Colors match accent.
4. **Section: "EXPENSE TREND"**
   - **Bar chart**: one bar per month. X: month labels (Mon YY). Y: |expenses|/100. All bars `rgba(255,107,107,0.55)` border `#ff6b6b` except last month (current) in `rgba(78,205,196,0.7)` border `#4ecdc4`. borderRadius 6, borderSkipped false. Axis: mono 10px, y-axis callback `v >= 1000 ? (v/1000)+'k' : v`. Grid: `#111820`.
5. **Two-column grid** (16px gap):
   - Left: **"INCOME VS EXPENSE"** — line chart, two datasets. Income: teal `#4ecdc4`, 2px stroke, fill 0.05 alpha, tension 0.35, pointRadius 3. Expenses: coral `#ff6b6b`, same. Legend top-end, mono 10px.
   - Right: **"NET SAVINGS"** — bar chart. Positive bars teal, negative bars coral. borderRadius 5.
6. **Section: "MONTHLY DETAIL"**
   - **Table** (inside chart-panel, no extra padding): Columns: Month | Income | Expenses | Net | (bar). Income in teal, expenses in coral, net teal if positive / red if negative. Inline bar: width proportional to expenses/max. Rows newest first.
7. **Section: "CATEGORY HEATMAP"**
   - **Heatmap table**: rows = top 10 categories by total spend from trends data. Columns = months. Cell value: |spent|/100 as integer. 5-level color scale:
     - 0: transparent, text-muted, "—"
     - <15% of p90: `rgba(78,205,196,0.06)`, dim teal text
     - <35%: `rgba(78,205,196,0.12)`
     - <65%: `rgba(78,205,196,0.2)`
     - <90%: `rgba(255,107,107,0.12)`, dim red text
     - >=90%: `rgba(255,107,107,0.22)`, bright red text
   - Cell hover: scale(1.15) transform.
8. **Footer**

## Design
- Use the alternate palette (--bg: #06080a, --surface: #0d1014, etc.)
- Radial glow on body::after for atmospheric depth
- All charts: aspect ratio 2.8 for bar, 1.6 for line/net
- Month labels: `new Date(YYYY, MM-1).toLocaleDateString('en', { month: 'short' }) + ' ' + YY`

## Empty State
If monthly data is empty: "No transaction data found for the requested period."
