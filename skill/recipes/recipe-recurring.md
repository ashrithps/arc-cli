---
name: recipe-recurring
description: Recurring payments and subscriptions tracker with monthly cost estimate
---

# Recurring Payments

## Trigger
"recurring payments", "subscriptions", "subscription tracker", "what do I pay every month", "scheduled payments", "recurring expenses", "fixed costs"

## Data Commands
```bash
arc schedules list --json
arc schedules upcoming --json
```
List returns all schedules. Upcoming returns non-completed schedules sorted by next_date.

Schedule shape: `{ id, name, amount, next_date, frequency, payee, category, account, completed }`

Filter: exclude `completed === true` schedules from all views.

## Layout

1. **Arc nav bar**
2. **Header**: "Recurring" + subtitle "Scheduled Payments"
3. **Hero total**: estimated monthly cost. Computation:
   - For each active schedule: `|amount| / 100`
   - weekly: multiply by 4.33
   - monthly: multiply by 1
   - yearly: divide by 12
   - Sum all. Display in DM Serif 72px, gold `#e8c468` color.
4. **Stat cards** (3-col):
   - "ACTIVE" (gold): count of non-completed schedules
   - "MONTHLY EST." (red): same as hero
   - "NEXT 7 DAYS" (teal): sum of `|amount|/100` for schedules where next_date is within 7 days from today
5. **Section: "UPCOMING PAYMENTS"**
   - **Timeline cards** (vertical list): sorted by next_date ascending. Each row:
     - Left: date badge — rounded rect (40px wide, surface bg, accent border), day number (mono 18px bold) + month abbreviation (mono 9px dim) stacked.
     - Right: card with payment name/payee (Outfit 14px 500), amount (mono 16px, coral), frequency badge (mono 9px uppercase pill, e.g., "MONTHLY"), account name (11px dim).
     - Vertical line connecting date badges: 2px wide, `--border` color, via `::before` pseudo-element on container.
6. **Section: "ALL SCHEDULES"**
   - **Table**: Columns: Name/Payee | Amount | Frequency | Next Date | Account | Category. Mono amounts. Sort by next_date. Hover highlight.
7. **Footer**

## Design
- Gold (#e8c468) as primary accent — recurring costs are commitments, not warnings
- Date badge: use accent border color for imminent payments (within 7 days), border color for others
- Frequency badges: "DAILY" / "WEEKLY" / "MONTHLY" / "YEARLY" in uppercase mono
- Timeline vertical line: absolute positioned, runs through the date badge column

## Empty State
If no active schedules: centered message "No recurring payments found. Create one with `arc schedules create`." with dim styling.
