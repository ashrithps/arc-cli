---
name: recipe-health
description: Financial health scorecard with composite score, savings rate, and spending velocity
---

# Financial Health Scorecard

## Trigger
"financial health", "health check", "financial scorecard", "how am I doing financially", "report card", "money health"

## Data Commands (run in parallel where possible)
```bash
arc query monthly --months 6 --json
arc query spending --month YYYY-MM --json
arc budgets summary --month YYYY-MM --json
arc query uncategorized --json
arc query accounts --json
arc schedules list --json
```

## Score Calculation

Composite score 0-100, weighted:

1. **Savings Rate (30 pts)**: avg `net / income` over 6 months. Map: >20% = 30, 10-20% = 22, 0-10% = 15, negative = 5.
2. **Budget Adherence (25 pts)**: if `totalBudgeted > 0`: `min(totalBalance / totalBudgeted, 1) * 25`. If no budgets set: 15 (neutral).
3. **Categorization (20 pts)**: `(1 - uncategorized_count / total_recent_transactions) * 20`. If no uncategorized: full 20.
4. **Consistency (25 pts)**: compute std deviation of monthly |expenses|. Lower = better. Map: stddev < 10% of mean = 25, 10-25% = 18, 25-50% = 12, >50% = 5.

## Layout

1. **Arc nav bar**
2. **Header**: "Financial Health" + subtitle "Scorecard"
3. **Score gauge** (centered, 200×200px): SVG circle. Background ring: `--border` color, strokeWidth 8. Foreground arc: stroke-dasharray animated, color based on score (teal >70, gold 40-70, coral <40). Center: score number (DM Serif 64px) + "/100" (mono 16px dim). Animate dasharray on load over 1.5s.
   ```html
   <svg width="200" height="200" viewBox="0 0 200 200">
     <circle cx="100" cy="100" r="85" fill="none" stroke="var(--border)" stroke-width="8"/>
     <circle cx="100" cy="100" r="85" fill="none" stroke="SCORE_COLOR" stroke-width="8"
       stroke-dasharray="534" stroke-dashoffset="OFFSET" stroke-linecap="round"
       transform="rotate(-90 100 100)" style="transition: stroke-dashoffset 1.5s ease"/>
   </svg>
   ```
   `OFFSET = 534 - (534 * score / 100)`
4. **Score breakdown cards** (4-col):
   - Each card: factor name + "X / Y" score (e.g., "22 / 30"), one-line explanation.
   - Color: teal if >70% of possible, gold if 40-70%, coral if <40%.
   - Colored top accent line matching score color.
5. **Section: "SAVINGS RATE"**
   - **Bar chart**: net per month. Positive teal, negative coral. borderRadius 5.
6. **Section: "SPENDING VELOCITY"**
   - **Line chart**: monthly |expenses|/100 over 6 months. Coral line, 2px stroke, tension 0.35. Add a CSS-dashed trend line (linear regression) to show if expenses are increasing/decreasing.
7. **Section: "QUICK STATS"**
   - **2-column key-value layout** (not a table, styled as pairs): Net worth, Avg monthly income, Avg monthly expenses, Savings rate %, Active recurring payments, Uncategorized transactions, Active accounts. Labels in dim mono, values in Outfit 500.
8. **Small footnote**: "Score methodology: Savings Rate (30%), Budget Adherence (25%), Categorization (20%), Spending Consistency (25%)." in text-muted 10px.
9. **Footer**

## Design
- The SVG gauge is the visual centerpiece — not a Chart.js chart. Hand-built SVG circle with animated stroke-dashoffset.
- Score colors: >70 teal `#4ecdc4`, 40-70 gold `#e8c468`, <40 coral `#ff6b6b`
- This is the most data-intensive recipe (6 commands). Agent should run them in parallel.

## Empty State
If insufficient data (< 2 months of monthly data): "Not enough history to compute a health score. Try again after 2+ months of data."
