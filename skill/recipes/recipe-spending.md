---
name: recipe-spending
description: Monthly spending breakdown with donut chart and category cards
---

# Monthly Spending Breakdown

## Trigger
"show my spending", "spending breakdown", "where did my money go", "monthly spending", "spending dashboard", "what did I spend"

## Data Commands
```bash
arc query spending --month YYYY-MM --json
```
Returns: `[{ category, categoryId, spent, budgeted, balance }]`

Filter: exclude categories with `spent === 0`. Amounts are integers in minor units — divide by 100.

## Layout

1. **Arc nav bar** (sticky)
2. **Header**: title "Spending" (DM Serif Display 42px), subtitle badge with month name (JetBrains Mono 12px, accent color)
3. **Hero section** (flex row: total left, donut right):
   - Left: label "TOTAL OUTFLOW" (mono 11px, uppercase, letter-spacing 4px), amount = sum of `|spent|/100` (DM Serif 72px, coral #e85d5d). Decimal portion 36px, text-dim. Animate count-up 1.2s easeOutCubic. Below: pill badge "N categories with spend" (red-dim bg, mono 12px).
   - Right: **Donut chart** (260×260px). cutout 68%, borderColor `--bg`, borderWidth 3, borderRadius 4, spacing 2. Center label: category count (mono 13px bold) + "Categories" (10px uppercase). Colors: `--cat-1` through `--cat-9`.
4. **Section heading**: "CATEGORY BREAKDOWN"
5. **Category cards** (3-col grid, 12px gap): For each category sorted by |spent| desc:
   - Card: surface bg, 1px border, 12px radius, 20px padding. 3px colored left border (cycling cat-1 to cat-9).
   - Header row: category name (Outfit 13px 500) + percentage (mono 11px dim).
   - Amount: JetBrains Mono 22px 700, -0.5px letter-spacing.
   - Progress bar: 4px height, `--border` bg, colored fill. Width = `(this_spent / max_spent) * 100%`. Animate from 0 over 1s cubic-bezier(0.22,1,0.36,1).
   - Hover: translateY(-2px), surface-hover bg.
   - Stagger animation: fadeUp 0.5s, delay 0.06s per card.
6. **Inflow section** (if any category has positive spent): section heading "INFLOWS", card with green dot + category name + "+X.XX" in green mono.
7. **Footer**

## Design
- Hero total color: coral red `#e85d5d`
- Progress bar width is relative to the largest category (not total), so top category = 100%
- Donut legend: hide Chart.js legend, the cards serve as legend
- Tooltip: surface bg, warm text, mono body font, 8px radius, 12px padding

## Empty State
If all categories have `spent === 0`: centered message "No spending recorded for {month}." in text-dim.
