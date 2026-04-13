---
name: recipe-upcoming
description: Upcoming payment calendar with timeline, urgency indicators, and account coverage
---

# Upcoming Payments

## Trigger
"upcoming payments", "what's due", "payment calendar", "bills coming up", "what do I owe", "upcoming bills", "scheduled calendar", "bills due"

## Data Commands
```bash
arc schedules upcoming --json
arc query accounts --json
```
Upcoming: non-completed schedules sorted by next_date. Shape: `{ id, name, amount, next_date, frequency, payee, category, account }`
Accounts: `[{ name, id, balance, ... }]` for coverage calculation.

Filter to next 30 days: only include schedules where `next_date` is within 30 days from today.

## Layout

1. **Arc nav bar**
2. **Header**: "Upcoming" + subtitle "Next 30 Days"
3. **Hero total**: sum of |amount|/100 for schedules due within 30 days. DM Serif 72px, coral `#ff6b6b`. Label "TOTAL DUE".
4. **Stat cards** (3-col):
   - "THIS WEEK" (red): sum of |amount|/100 due within 7 days
   - "THIS MONTH" (gold): sum within 30 days (same as hero)
   - "PAYMENTS" (teal): count of upcoming payments
5. **Section: "TIMELINE"**
   - **Vertical timeline**: CSS vertical line (2px, `--border`, absolute positioned in a left column). Each payment as a row:
     - Left: **date circle** (48px, border 2px accent, surface bg). Day number centered (mono 18px bold). Month abbreviation below (mono 9px dim).
     - Right: **payment card** (surface bg, border, 12px radius, 16px padding):
       - Payment name/payee (Outfit 14px 500)
       - Amount (mono 18px, coral)
       - Account name (11px dim)
       - Category badge (if available, mono 9px pill)
       - **Days-until badge**: computed `Math.ceil((nextDate - today) / 86400000)`.
         - 0 (today): coral bg, white text, "TODAY", subtle CSS pulse animation
         - 1-2: coral text, "TOMORROW" / "IN 2 DAYS"
         - 3-7: gold text, "IN X DAYS"
         - 8+: dim text, "IN X DAYS"
     - Vertical line connects all date circles via `::before` pseudo on the timeline container.
6. **Section: "ACCOUNT COVERAGE"**
   - **Coverage cards** (2-col grid): for each account that has upcoming payments:
     - Account name (Outfit 14px 600)
     - Current balance (mono 16px, teal)
     - Total upcoming debits: sum of |amount|/100 for schedules in this account
     - Remaining: balance - upcoming. Teal if positive, coral if negative.
     - **Coverage bar**: full width = current balance, filled portion = upcoming debits. If upcoming > balance, bar overflows red. borderRadius 4px, height 6px.
7. **Section: "SCHEDULE LIST"**
   - **Table**: all upcoming. Columns: Due Date | Name/Payee | Amount | Frequency | Account. Sort by date asc. Mono amounts.
8. **Footer**

## Design
- Timeline: the signature visual element. Date circles are 48px with 2px border in accent color for this-week items, `--border` for later items.
- "TODAY" badge: add `@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }` with `animation: pulse 2s infinite`.
- Coverage cards: show whether the user can cover upcoming bills. This is a uniquely actionable insight.
- If upcoming > balance for an account, the coverage bar shows overflow with coral glow + text "Shortfall: X.XX".

## Empty State
If no upcoming schedules: centered message "No upcoming payments scheduled." with dim styling.
