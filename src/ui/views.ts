import chalk from 'chalk';
import { colors, sym, formatAmount, header, subheader, row, divider, badge, statusDot } from './theme.js';
import { formatCurrency, printTable } from '../utils/format.js';

// ── Brand ─────────────────────────────────────────────────────

export function printBanner() {
  console.log('');
  console.log(colors.primary('  ╔═══════════════════════════════════════╗'));
  console.log(colors.primary('  ║') + chalk.bold.white('   arc   ') + colors.muted('— Actual Budget Manager  ') + colors.primary('║'));
  console.log(colors.primary('  ╚═══════════════════════════════════════╝'));
  console.log('');
}

// ── Connection ────────────────────────────────────────────────

export function printConnection(config: { serverURL: string; budgetSyncId?: string; encrypted: boolean }, accounts: any[]) {
  console.log(header('Connection'));
  console.log(row('Server', colors.secondary(config.serverURL)));
  console.log(row('Budget', config.budgetSyncId || colors.muted('auto-selected')));
  console.log(row('Encryption', config.encrypted ? colors.warning(sym.lock + ' enabled') : colors.muted(sym.unlock + ' disabled')));
  console.log(row('Status', colors.success(sym.check + ' Connected')));

  printAccounts(accounts);
}

// ── Accounts ──────────────────────────────────────────────────

export function printAccounts(accounts: any[]) {
  console.log(header(`Accounts (${accounts.length})`));

  const onBudget = accounts.filter((a: any) => !a.offbudget && !a.closed);
  const offBudget = accounts.filter((a: any) => a.offbudget && !a.closed);
  const closed = accounts.filter((a: any) => a.closed);

  if (onBudget.length > 0) {
    console.log(subheader('On Budget'));
    printAccountGroup(onBudget);
  }

  if (offBudget.length > 0) {
    console.log(subheader('Off Budget'));
    printAccountGroup(offBudget);
  }

  if (closed.length > 0) {
    console.log(subheader(colors.muted('Closed')));
    for (const a of closed) {
      console.log(`    ${colors.dim(sym.circle)} ${colors.dim(a.name)}`);
    }
  }

  // Total
  const totalBal = accounts.reduce((s: number, a: any) => s + (a.balance_current || 0), 0);
  console.log('');
  console.log(`  ${colors.dim(sym.dash.repeat(40))}`);
  console.log(`  ${'Total'.padEnd(32)} ${formatAmount(totalBal)}`);
  console.log('');
}

function printAccountGroup(accounts: any[]) {
  const maxName = Math.max(...accounts.map((a: any) => a.name.length), 20);
  for (const a of accounts) {
    const bal = a.balance_current || 0;
    const icon = getAccountIcon(a.type || 'checking');
    const name = a.name.padEnd(maxName + 2);
    console.log(`    ${icon} ${chalk.white(name)} ${formatAmount(bal)}`);
  }
}

function getAccountIcon(type: string): string {
  const icons: Record<string, string> = {
    checking: colors.primary(sym.bank),
    savings: colors.success(sym.bank),
    credit: colors.accent(sym.card),
    investment: colors.secondary(sym.chart),
    mortgage: colors.warning('🏠'),
    debt: colors.error(sym.card),
  };
  return icons[type] || colors.muted(sym.dot);
}

// ── Transactions ──────────────────────────────────────────────

export function printTransactions(txns: any[], accountName?: string) {
  console.log(header(`Transactions${accountName ? ' — ' + accountName : ''} (${txns.length})`));

  if (txns.length === 0) {
    console.log(`  ${colors.muted('No transactions found.')}`);
    return;
  }

  // Header row
  const hdr = `  ${'Date'.padEnd(12)}${'Payee'.padEnd(26)}${'Category'.padEnd(18)}${'Amount'.padStart(14)}  ${'Clr'}`;
  console.log(colors.dim(hdr));
  console.log(`  ${colors.dim(sym.dash.repeat(75))}`);

  for (const t of txns) {
    const date = t.date || '';
    const payee = (t.payee_name || t.imported_payee || '').slice(0, 24);
    const cat = (t.category_name || '').slice(0, 16);
    const amount = t.amount || 0;
    const cleared = t.cleared ? colors.success(sym.check) : colors.dim(sym.circle);
    const parent = t.is_parent ? colors.primary(' [split]') : '';

    const amtStr = formatAmount(amount);
    const line = `  ${colors.muted(date.padEnd(12))}${chalk.white(payee.padEnd(26))}${colors.muted(cat.padEnd(18))}${amtStr.padStart(22)}  ${cleared}${parent}`;
    console.log(line);
  }

  // Summary
  const totalDebit = txns.filter((t: any) => t.amount < 0).reduce((s: number, t: any) => s + t.amount, 0);
  const totalCredit = txns.filter((t: any) => t.amount > 0).reduce((s: number, t: any) => s + t.amount, 0);

  console.log(`  ${colors.dim(sym.dash.repeat(75))}`);
  console.log(`  ${''.padEnd(56)}${formatAmount(totalCredit).padStart(14)}  ${colors.success('in')}`);
  console.log(`  ${''.padEnd(56)}${formatAmount(totalDebit).padStart(14)}  ${colors.debit('out')}`);
  console.log(`  ${''.padEnd(56)}${formatAmount(totalCredit + totalDebit).padStart(14)}  ${chalk.bold('net')}`);
  console.log('');
}

// ── Budget ────────────────────────────────────────────────────

export function printBudgetMonth(budget: any, month: string) {
  console.log(header(`Budget — ${month}`));

  if (budget.toBudget != null) {
    const tbColor = budget.toBudget >= 0 ? colors.success : colors.error;
    console.log(row('To Budget', tbColor(formatAmount(budget.toBudget))));
  }

  for (const group of budget.categoryGroups || []) {
    console.log(`\n  ${colors.primary(sym.dot)} ${chalk.bold.white(group.name)}`);

    const cats = group.categories || [];
    if (cats.length === 0) continue;

    // Header
    console.log(colors.dim(`    ${'Category'.padEnd(22)} ${'Budgeted'.padStart(12)} ${'Spent'.padStart(12)} ${'Balance'.padStart(12)}`));
    console.log(`    ${colors.dim(sym.dash.repeat(60))}`);

    for (const cat of cats) {
      const budgeted = cat.budgeted || 0;
      const spent = cat.spent || 0;
      const balance = cat.balance || 0;

      // Progress bar
      const pct = budgeted !== 0 ? Math.min(Math.abs(spent) / Math.abs(budgeted), 1) : 0;
      const barWidth = 8;
      const filled = Math.round(pct * barWidth);
      const barColor = pct > 0.9 ? colors.error : pct > 0.7 ? colors.warning : colors.success;
      const bar = barColor('█'.repeat(filled)) + colors.dim('░'.repeat(barWidth - filled));

      const name = cat.name.slice(0, 20).padEnd(22);
      console.log(`    ${chalk.white(name)} ${formatAmount(budgeted).padStart(18)} ${formatAmount(spent).padStart(18)} ${formatAmount(balance).padStart(18)} ${bar}`);
    }
  }
  console.log('');
}

// ── Categories ────────────────────────────────────────────────

export function printCategories(groups: any[]) {
  console.log(header('Categories'));

  for (const group of groups) {
    const income = group.is_income ? colors.success(' [income]') : '';
    console.log(`\n  ${colors.primary(sym.dot)} ${chalk.bold.white(group.name)}${income} ${colors.dim(group.id.slice(0, 8))}`);

    for (const cat of group.categories || []) {
      const hidden = cat.hidden ? colors.dim(' [hidden]') : '';
      const prefix = cat === group.categories[group.categories.length - 1] ? sym.corner : sym.tee;
      console.log(`    ${colors.dim(prefix)} ${chalk.white(cat.name)}${hidden} ${colors.dim(cat.id.slice(0, 8))}`);
    }
  }
  console.log('');
}

// ── Payees ────────────────────────────────────────────────────

// ── Tags ──────────────────────────────────────────────────────

export function printTags(tags: any[]) {
  console.log(header(`Tags (${tags.length})`));
  if (tags.length === 0) {
    console.log(`  ${colors.dim('(no tags yet — try: arc tags add <name>)')}\n`);
    return;
  }
  for (const t of tags) {
    const dot = t.color ? chalk.hex(t.color)(sym.bullet) : colors.muted(sym.bullet);
    const desc = t.description ? colors.dim(`  ${t.description}`) : '';
    const colorTxt = t.color ? colors.dim(`  ${t.color}`) : '';
    console.log(`  ${dot} ${chalk.white(t.tag)}${colorTxt}${desc} ${colors.dim(t.id.slice(0, 8))}`);
  }
  console.log('');
}

export function printPayees(payees: any[], showTransfers: boolean = false) {
  const filtered = showTransfers ? payees : payees.filter((p: any) => !p.transfer_acct);
  console.log(header(`Payees (${filtered.length})`));

  for (const p of filtered) {
    const xfer = p.transfer_acct ? colors.transfer(` ${sym.arrow} transfer`) : '';
    console.log(`  ${colors.muted(sym.bullet)} ${chalk.white(p.name)}${xfer} ${colors.dim(p.id.slice(0, 8))}`);
  }
  console.log('');
}

// ── Budget Files ──────────────────────────────────────────────

export function printBudgetFiles(budgets: any[], serverURL: string) {
  console.log(header('Budget Files'));
  console.log(row('Server', colors.secondary(serverURL)));
  console.log('');

  for (let i = 0; i < budgets.length; i++) {
    const b = budgets[i];
    const enc = b.encryptKeyId ? colors.warning(sym.lock) : colors.dim(sym.unlock);
    console.log(`  ${colors.primary(String(i + 1) + '.')} ${chalk.bold.white(b.name)} ${enc}`);
    console.log(`     ${colors.muted('ID:')} ${colors.dim(b.cloudFileId)}`);
    if (b.groupId) console.log(`     ${colors.muted('Group:')} ${colors.dim(b.groupId)}`);
    console.log('');
  }
}

// ── Spending Summary ──────────────────────────────────────────

export function printSpendingSummary(summary: any[], month: string) {
  console.log(header(`Spending — ${month}`));

  // Sort by spent (most spending first)
  const sorted = [...summary].sort((a, b) => a.spent - b.spent);

  console.log(colors.dim(`  ${'Category'.padEnd(22)} ${'Budgeted'.padStart(12)} ${'Spent'.padStart(12)} ${'Balance'.padStart(12)}`));
  console.log(`  ${colors.dim(sym.dash.repeat(60))}`);

  for (const s of sorted) {
    if (s.spent === 0 && s.budgeted === 0) continue;
    const name = s.category.slice(0, 20).padEnd(22);
    console.log(`  ${chalk.white(name)} ${formatAmount(s.budgeted).padStart(18)} ${formatAmount(s.spent).padStart(18)} ${formatAmount(s.balance).padStart(18)}`);
  }
  console.log('');
}

// ── Rules ─────────────────────────────────────────────────────

export function printRules(rules: any[]) {
  console.log(header(`Rules (${rules.length})`));

  for (const r of rules) {
    const stage = badge(r.stage || 'default', r.stage === 'pre' ? colors.warning : r.stage === 'post' ? colors.accent : colors.primary);
    const op = colors.muted(r.conditionsOp || 'and');
    console.log(`  ${colors.dim(r.id.slice(0, 8))} ${stage} ${op} ${colors.muted(r.conditions?.length + ' conditions')} ${sym.arrow} ${colors.muted(r.actions?.length + ' actions')}`);
  }
  console.log('');
}

// ── Schedules ─────────────────────────────────────────────────

export function printSchedules(schedules: any[]) {
  console.log(header(`Schedules (${schedules.length})`));

  for (const s of schedules) {
    const completed = s.completed ? colors.success(sym.check) : colors.dim(sym.circle);
    const name = (s.name || 'Unnamed').slice(0, 25);
    const next = s.next_date || colors.muted('none');
    console.log(`  ${completed} ${chalk.white(name.padEnd(28))} ${colors.muted('next:')} ${next}`);
  }
  console.log('');
}

// ── Backups ───────────────────────────────────────────────────

export function printBackups(backups: string[]) {
  console.log(header(`Backups (${backups.length})`));

  if (backups.length === 0) {
    console.log(`  ${colors.muted('No backups found.')}`);
    return;
  }

  for (const b of backups) {
    console.log(`  ${colors.dim(sym.bullet)} ${chalk.white(b)}`);
  }
  console.log('');
}

// ── Help ──────────────────────────────────────────────────────

export function printHelp() {
  printBanner();

  const cmd = (name: string, desc: string) =>
    `  ${colors.primary(name.padEnd(18))} ${colors.muted(desc)}`;

  console.log(chalk.bold.white('  Commands'));
  console.log(divider(50));
  console.log(cmd('files', 'List available budget files'));
  console.log(cmd('connect', 'Connect and show budget info'));
  console.log(cmd('doctor', 'Run Actual health checks'));
  console.log(cmd('ui', 'Launch the TUI'));
  console.log(cmd('mcp', 'Start the Arc MCP server over stdio'));
  console.log(cmd('accounts', 'List accounts with balances'));
  console.log(cmd('transactions', 'List/add/update/delete transactions'));
  console.log(cmd('categories', 'List/manage categories and savings targets'));
  console.log(cmd('payees', 'List/manage payees'));
  console.log(cmd('tags', 'List/add/update/delete tags'));
  console.log(cmd('rules', 'List/manage rules'));
  console.log(cmd('schedules', 'List/manage schedules'));
  console.log(cmd('budgets', 'List/switch budgets and manage budget amounts'));
  console.log(cmd('query', 'Smart queries (spending, uncategorized)'));
  console.log(cmd('portfolio', 'Holdings, trades, realized P/L, dividends, value history (read-only)'));
  console.log(cmd('goals', 'Savings goals — progress, contributions, deadlines'));
  console.log(cmd('debts', 'Cards, loans and BNPL — cycle state, statements, payoff, Pay here first'));
  console.log(cmd('statements', 'Statements arc filed: figures, reconciled, undo journal, payment due, fees'));
  console.log(cmd('splits', 'Group splits — share a cost, track who owes you'));
  console.log(cmd('reconcile', 'Check a bank statement against an account; apply it'));
  console.log(cmd('backup', 'List/clean backups'));
  console.log(cmd('auth pair <token>', 'Pair this machine with the arc app (--agent, --label)'));
  console.log(cmd('auth status', 'Pairing, secrets storage and last contact'));
  console.log(cmd('approvals', 'list / show / approve (Touch ID) / deny / wait / enroll-mac'));
  console.log(cmd('activity', 'What agents did here: --agent, --since 2h, --follow, --json'));
  console.log(cmd('agents', 'whoami (permissions for this agent) / list'));
  console.log(cmd('server', 'Server lifecycle (wake a sleeping server)'));
  console.log(cmd('wake', 'Shortcut for `arc server wake`'));
  console.log(cmd('update', 'Update arc to the latest published build'));
  console.log(cmd('version', 'Show the installed build'));
  console.log('');

  console.log(chalk.bold.white('  Flags'));
  console.log(divider(50));
  console.log(cmd('--json', 'Machine-readable JSON output'));
  console.log(cmd('--check', 'With `update`: report only, install nothing'));
  console.log(cmd('--budget=ID', 'Override budget sync ID'));
  console.log(cmd('--account=NAME', 'Target account (name or ID)'));
  console.log(cmd('--start=DATE', 'Start date (YYYY-MM-DD)'));
  console.log(cmd('--end=DATE', 'End date (YYYY-MM-DD)'));
  console.log(cmd('--month=YYYY-MM', 'Budget month'));
  console.log('');

  console.log(chalk.bold.white('  Examples'));
  console.log(divider(50));
  console.log(`  ${colors.dim('$')} ${colors.secondary('arc')} accounts`);
  console.log(`  ${colors.dim('$')} ${colors.secondary('arc')} ui`);
  console.log(`  ${colors.dim('$')} ${colors.secondary('arc')} budgets switch --budget=budget-2`);
  console.log(`  ${colors.dim('$')} ${colors.secondary('arc')} transactions list --account=Checking --start=2026-03-01`);
  console.log(`  ${colors.dim('$')} ${colors.secondary('arc')} budgets month --month=2026-03`);
  console.log(`  ${colors.dim('$')} ${colors.secondary('arc')} query spending --month=2026-03`);
  console.log('');
}

// ── Portfolio ─────────────────────────────────────────────────

function pctStr(pct: number | undefined): string {
  if (pct == null) return '';
  const v = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
  return v;
}

export function printHoldings(holdings: any[], accountName?: string) {
  console.log(header(`Holdings${accountName ? ' — ' + accountName : ''} (${holdings.length})`));
  if (holdings.length === 0) {
    console.log(`  ${colors.muted('No holdings found in detailed investment accounts.')}\n`);
    return;
  }
  printTable(holdings.map((h: any) => ({
    symbol: h.symbol,
    class: h.assetClass,
    qty: h.quantity,
    price: formatCurrency(h.markPrice || 0),
    value: formatCurrency(h.marketValue || 0),
    'P/L %': pctStr(h.unrealizedPnlPct),
    account: h.account,
  })));
  const total = holdings.reduce((s: number, h: any) => s + (h.marketValue || 0), 0);
  console.log(`\nTotal market value: ${formatCurrency(total)}`);
}

export function printHoldingDetail(detail: any) {
  const h = detail.holding;
  console.log(header(`Holding — ${h.symbol}${h.name ? ' (' + h.name + ')' : ''}`));
  const avgCost = h.costBasisPrice != null
    ? formatCurrency(h.costBasisPrice)
    : (h.costBasisMoney != null && h.quantity
        ? formatCurrency(Math.round(h.costBasisMoney / h.quantity))
        : colors.muted('—'));
  console.log(row('Account', h.account));
  console.log(row('Asset class', h.assetClass));
  console.log(row('Quantity', String(h.quantity)));
  console.log(row('Market price', formatCurrency(h.markPrice || 0)));
  console.log(row('Average cost', String(avgCost)));
  console.log(row('Market value', formatCurrency(h.marketValue || 0)));
  console.log(row('Unrealized P/L', h.unrealizedPnl != null
    ? `${formatCurrency(h.unrealizedPnl)} (${pctStr(h.unrealizedPnlPct) || '—'})`
    : colors.muted('—')));
  console.log(row('Allocation', `${detail.allocationPct.toFixed(2)}% of ${h.account}`));

  console.log(header(`Trades (${detail.trades.length})`));
  if (detail.trades.length === 0) {
    console.log(`  ${colors.muted('No trade activity recorded.')}\n`);
    return;
  }
  printTable(detail.trades.map((t: any) => ({
    date: t.date,
    kind: t.kind,
    detail: (t.detail || '').slice(0, 50),
    amount: formatCurrency(t.amount || 0),
  })));
}

export function printTrades(trades: any[]) {
  console.log(header(`Trades (${trades.length})`));
  if (trades.length === 0) {
    console.log(`  ${colors.muted('No trade activity found.')}\n`);
    return;
  }
  printTable(trades.map((t: any) => ({
    date: t.date,
    symbol: t.symbol,
    kind: t.kind,
    detail: (t.detail || '').slice(0, 44),
    amount: formatCurrency(t.amount || 0),
    account: t.account,
  })));
}

export function printPortfolioSummary(summary: any) {
  console.log(header('Portfolio Summary'));
  console.log(row('Total market value', formatCurrency(summary.totalMarketValue || 0)));
  console.log(row('Total unrealized P/L', formatCurrency(summary.totalUnrealizedPnl || 0)));

  console.log(subheader('By account'));
  printTable((summary.byAccount || []).map((s: any) => ({
    account: s.key,
    value: formatCurrency(s.marketValue || 0),
    '%': s.pct.toFixed(2) + '%',
  })));

  console.log(subheader('By asset class'));
  printTable((summary.byAssetClass || []).map((s: any) => ({
    'asset class': s.key,
    value: formatCurrency(s.marketValue || 0),
    '%': s.pct.toFixed(2) + '%',
  })));
}

export function printPortfolioAccounts(accounts: any[]) {
  console.log(header(`Investment Accounts (${accounts.length})`));
  if (accounts.length === 0) {
    console.log(`  ${colors.muted('No investment accounts found.')}\n`);
    return;
  }
  printTable(accounts.map((a: any) => ({
    name: a.name,
    type: a.type,
    mode: a.mode,
    source: a.src,
    value: a.mode === 'detailed' ? formatCurrency(a.value || 0) : colors.muted('—'),
  })));
}

function rangeLabel(from?: string, to?: string): string {
  if (!from && !to) return '';
  return ` · ${from ?? '…'} → ${to ?? 'today'}`;
}

export function printRealized(report: any, accountName?: string) {
  console.log(header(`Realized P/L${accountName ? ' — ' + accountName : ''}${rangeLabel(report.from, report.to)}`));
  if (report.trades.length === 0) {
    console.log(`  ${colors.muted('No closed trades recorded. The arc app fills this in when a brokerage sync (e.g. IBKR Flex) imports trades.')}\n`);
    return;
  }
  const s = report.stats;
  console.log(row('Net realized', formatCurrency(s.netRealizedCents)));
  console.log(row('Closed trades', `${s.totalTrades} (${s.winningTrades} won, ${s.losingTrades} lost, ${s.breakevenTrades} even)`));
  console.log(row('Win rate', (s.winRate * 100).toFixed(1) + '%'));
  console.log(row('Profit factor', s.profitFactor == null ? '∞' : s.profitFactor.toFixed(2)));
  console.log(row('Edge', report.tier));
  console.log(row('Avg winner / loser', `${formatCurrency(s.avgWinnerCents)} / ${formatCurrency(s.avgLoserCents)}`));
  console.log(row('Largest gain / loss', `${formatCurrency(s.largestGainCents)} / ${formatCurrency(-s.largestLossCents)}`));
  console.log(row('Fees', formatCurrency(s.totalFeesCents)));

  const groupRows = (groups: any[], label: string) => groups.map((g: any) => ({
    [label]: g.key || '—',
    closed: g.closed,
    'W/L': `${g.wins}/${g.losses}`,
    realized: formatCurrency(g.realized),
    fees: formatCurrency(g.fees),
  }));
  console.log(subheader('By symbol'));
  printTable(groupRows(report.bySymbol, 'symbol'));
  console.log(subheader(`By ${report.period}`));
  printTable(groupRows(report.byPeriod, report.period));
  if (report.byAccount.length > 1) {
    console.log(subheader('By account'));
    printTable(groupRows(report.byAccount, 'account'));
  }
}

export function printDividends(report: any, accountName?: string) {
  console.log(header(`Dividends${accountName ? ' — ' + accountName : ''} (${report.count})${rangeLabel(report.from, report.to)}`));
  if (report.count === 0) {
    console.log(`  ${colors.muted('No dividends recorded. The arc app fills this in when a brokerage sync (e.g. IBKR Flex) imports cash activity.')}\n`);
    return;
  }
  console.log(row('Total received', formatCurrency(report.total)));

  const totalRows = (totals: any[], label: string) => totals.map((t: any) => ({
    [label]: t.key || '—',
    payments: t.count,
    total: formatCurrency(t.total),
  }));
  console.log(subheader('By symbol'));
  printTable(totalRows(report.bySymbol, 'symbol'));
  console.log(subheader('By year'));
  printTable(totalRows(report.byYear, 'year'));
  if (report.byAccount.length > 1) {
    console.log(subheader('By account'));
    printTable(totalRows(report.byAccount, 'account'));
  }
  console.log(subheader('Payments'));
  printTable(report.rows.map((r: any) => ({
    date: r.date,
    symbol: r.symbol || '—',
    amount: formatCurrency(r.amount),
    account: r.account,
  })));
}

/** Points shown in the terminal; --json returns the full series. */
const HISTORY_TAIL = 30;

export function printPortfolioHistory(report: any, accountName?: string) {
  console.log(header(`Portfolio Value History${accountName ? ' — ' + accountName : ''}${rangeLabel(report.from, report.to)}`));
  if (report.series.length === 0) {
    console.log(`  ${colors.muted('No value history recorded. The arc app records one point per day while a detailed investment account syncs; widen --from/--to or check `arc portfolio accounts`.')}\n`);
    return;
  }
  const last = report.series[report.series.length - 1];
  console.log(row('Latest', `${formatCurrency(last.value)} on ${last.date}`));
  if (report.change) {
    const pct = report.change.start !== 0 ? (report.change.delta / Math.abs(report.change.start)) * 100 : undefined;
    console.log(row('Change', `${formatCurrency(report.change.delta)}${pct != null ? ' (' + pctStr(pct) + ')' : ''} since ${report.series[0].date}`));
  }

  console.log(subheader('By account'));
  printTable(report.accounts.map((a: any) => ({
    account: a.account,
    days: a.days,
    from: a.firstDate ?? '—',
    to: a.lastDate ?? '—',
    latest: a.latestValue == null ? colors.muted('—') : formatCurrency(a.latestValue),
    'top mover': a.movers[0] ? `${a.movers[0].symbol} ${formatCurrency(a.movers[0].delta)}` : '—',
  })));

  const tail = report.series.slice(-HISTORY_TAIL);
  console.log(subheader(report.series.length > HISTORY_TAIL
    ? `Last ${HISTORY_TAIL} of ${report.series.length} days (--json for all)`
    : `Daily value (${report.series.length} days)`));
  printTable(tail.map((p: any) => ({ date: p.date, value: formatCurrency(p.value) })));
}

// ── Generic Success/Error ─────────────────────────────────────

export function printSuccess(msg: string) {
  console.log(`  ${colors.success(sym.check)} ${chalk.white(msg)}`);
}

export function printError(msg: string) {
  console.log(`  ${colors.error(sym.cross)} ${chalk.white(msg)}`);
}

export function printInfo(msg: string) {
  console.log(`  ${colors.primary(sym.dot)} ${colors.muted(msg)}`);
}

// ── Goals ─────────────────────────────────────────────────────

const GOAL_STATUS_LABEL: Record<string, string> = {
  completed: 'completed',
  ahead: 'ahead',
  on_track: 'on track',
  behind: 'behind',
  overdue: 'overdue',
};

function goalStatus(status: string): string {
  const label = GOAL_STATUS_LABEL[status] ?? status;
  switch (status) {
    case 'completed':
    case 'ahead':
    case 'on_track':
      return colors.success(label);
    case 'behind':
      return colors.warning(label);
    case 'overdue':
      return colors.error(label);
    default:
      return colors.muted(label);
  }
}

/** A compact 20-cell progress bar. */
function goalBar(pct: number): string {
  const width = 20;
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return `${'█'.repeat(filled)}${colors.dim('░'.repeat(width - filled))}`;
}

export function printGoals(goals: any[]) {
  console.log(header(`Goals (${goals.length})`));
  if (goals.length === 0) {
    console.log(`  ${colors.muted('No goals yet. Create one with `arc goals create --account <name> --target <amount>`.')}\n`);
    return;
  }
  printTable(goals.map((g: any) => ({
    goal: `${g.isCurrent ? sym.star + ' ' : ''}${g.goalName}`,
    funded: formatCurrency(g.progress.fundedAmount),
    target: formatCurrency(g.progress.targetAmount),
    '%': `${Math.round(g.progress.percentage)}%`,
    status: goalStatus(g.progress.status),
    deadline: g.deadline || colors.muted('—'),
    ...(g.isArchived ? { archived: 'yes' } : {}),
  })));
}

export function printGoalDetail(goal: any) {
  const p = goal.progress;
  console.log(header(`Goal — ${goal.goalName}`));
  console.log(row('Account', goal.accountName));
  console.log(row('Behavior', goal.behavior === 'set_aside' ? 'set aside (tracked contributions)' : 'have a balance of'));
  console.log('');
  console.log(`  ${goalBar(p.percentage)}  ${Math.round(p.percentage)}%`);
  console.log('');
  console.log(row('Funded', formatCurrency(p.fundedAmount)));
  console.log(row('Target', formatCurrency(p.targetAmount)));
  console.log(row('Remaining', formatCurrency(p.remainingAmount)));
  console.log(row('Status', goalStatus(p.status)));
  if (goal.deadline) {
    console.log(row('Deadline', goal.deadline));
    if (p.daysRemaining != null) {
      console.log(row(
        'Time left',
        p.daysRemaining < 0
          ? colors.error(`${Math.abs(p.daysRemaining)} days overdue`)
          : `${p.daysRemaining} days`
      ));
    }
    if (p.monthlyAmountNeeded != null) {
      console.log(row('Needed / month', formatCurrency(p.monthlyAmountNeeded)));
    }
  }
  if (goal.isArchived) console.log(row('Archived', 'yes'));
  if (goal.isCurrent) console.log(row('Current goal', 'yes'));
  console.log('');
}

const DEBT_STATE_LABEL: Record<string, string> = {
  nothing_due: 'nothing due',
  autopay: 'autopay',
  paid: 'paid',
  part_paid: 'part paid',
  unpaid: 'unpaid',
  overdue: 'overdue',
};

function debtStateText(state: string | null | undefined, daysPastDue = 0): string {
  if (!state) return colors.muted('no due day');
  const label = DEBT_STATE_LABEL[state] ?? state;
  if (state === 'overdue') return colors.error(daysPastDue ? `${label} ${daysPastDue}d` : label);
  if (state === 'paid' || state === 'nothing_due') return colors.success(label);
  if (state === 'part_paid') return colors.warning(label);
  return label;
}

const money = (v: number | null | undefined, cur?: string | null) =>
  v == null ? colors.muted('—') : `${formatCurrency(v)}${cur ? ` ${cur}` : ''}`;
const pct = (v: number | null | undefined) => (v == null ? colors.muted('—') : `${Math.round(v * 100)}%`);

export function printDebts(list: any) {
  const debts: any[] = list.debts ?? [];
  console.log(header(`Debts (${debts.length})`));
  if (debts.length === 0) {
    console.log(`  ${colors.muted('No debts. Mark a card or loan with `arc debts set --account <name> --kind card --due <day>`.')}\n`);
  } else {
    printTable(debts.map((d: any) => ({
      account: d.tagged ? d.accountName : `${d.accountName} ${colors.muted('(untagged)')}`,
      kind: d.kind,
      owed: money(d.owed),
      due: d.dueDate ?? colors.muted('—'),
      state: debtStateText(d.state, d.daysPastDue),
      'amount due': money(d.amountDue, d.currency),
      minimum: money(d.minimum, d.currency),
      left: money(d.left, d.currency),
      used: pct(d.utilisation),
    })));
  }
  const t = list.totals;
  if (t && debts.length > 0) {
    console.log(row('Total owed', formatCurrency(t.owed)));
    if (t.interestYear || t.feesYear) {
      console.log(row('Interest this year', formatCurrency(t.interestYear)));
      console.log(row('Fees this year', formatCurrency(t.feesYear)));
    }
    if (t.utilisation != null) console.log(row('Card utilisation', pct(t.utilisation)));
    if (t.debtFree) console.log(row('Debt-free', `${t.debtFree.month}${t.debtFree.by === 'pace' ? colors.muted(' (at the last three months\' pace)') : colors.muted(' (paying every minimum)')}`));
  }
  if (list.overdrawn?.length) {
    console.log(subheader('Overdrawn (not debt)'));
    for (const o of list.overdrawn) console.log(row(o.accountName, formatCurrency(o.balance)));
  }
  console.log('');
}

export function printDebtDetail(d: any) {
  const cur = d.currency;
  console.log(header(`${d.accountName} · ${d.kind}${d.tagged ? '' : ' (untagged)'}`));
  console.log(row('Owed', `${formatCurrency(d.owed)}${cur && d.owedCard != null ? colors.muted(` (${formatCurrency(d.owedCard)} ${cur})`) : ''}`));
  const c = d.cycle;
  if (c) {
    console.log(subheader('This cycle'));
    console.log(row('Due', `${c.dueDate ?? colors.muted('—')}${d.cycleLearned ? colors.muted(' (from its statements)') : ''}`));
    if (c.statementDate) console.log(row('Statement', c.statementDate));
    console.log(row('State', debtStateText(c.state, c.daysPastDue)));
    console.log(row('Amount due', `${money(c.amountDue, cur)}${c.amountDueSource ? colors.muted(` (${c.amountDueSource})`) : ''}`));
    console.log(row('Minimum', money(c.minimum, cur)));
    console.log(row('Paid', money(c.paid, cur)));
    console.log(row('Left', money(c.left, cur)));
    if (c.reportingDays != null && c.state === 'overdue') console.log(row('Reported after', `${c.reportingDays} days past due`));
  } else {
    console.log(`  ${colors.muted('No due day: set one with `arc debts set --due <day>` to follow its cycle.')}`);
  }
  const h = d.history;
  if (h && h.dots.length) {
    const dot: Record<string, string> = { full: colors.success('●'), min: colors.warning('◐'), none: colors.error('○'), skip: colors.muted('·') };
    console.log(row('Last cycles', h.dots.map((x: any) => dot[x.dot] ?? '?').join(' ')));
    console.log(row('On time', `${h.onTime} running${h.inFull ? `, ${h.inFull} in full` : ''} · best ${h.bestOnTime}`));
  }
  console.log(subheader('Details'));
  if (d.tagLine) console.log(row('Tag', colors.muted(d.tagLine)));
  if (d.limit != null) console.log(row('Limit', `${money(d.limit, cur)} · ${pct(d.utilisation)} used`));
  if (d.tag?.rate != null) console.log(row('Rate', `${d.tag.rate}% a year`));
  if (d.promoEnds) console.log(row('Promo ends', d.promoEnds));
  if (d.charges.interestYear || d.charges.feesYear) {
    console.log(row('Interest', `${formatCurrency(d.charges.interestMonth)} this month · ${formatCurrency(d.charges.interestYear)} this year`));
    console.log(row('Fees', `${formatCurrency(d.charges.feesYear)} this year`));
  }
  console.log(row('Paid off', `${Math.round(d.progress.paidOff * 100)}% of the most owed`));
  if (d.payoff?.months != null) {
    console.log(row('Payoff', `${d.payoff.months} months at ${money(d.payoff.payment, cur)} (${d.payoff.paymentSource}) · ${money(d.payoff.interest, cur)} interest · ${d.payoff.payoffMonth}`));
  } else if (d.payoff?.neverClears) {
    console.log(row('Payoff', colors.warning(`${money(d.payoff.payment, cur)} a month never clears it`)));
  }
  if (d.loanSchedule) console.log(row('Schedule', `${d.loanSchedule.due} of ${d.loanSchedule.term} instalments due · ${money(d.loanSchedule.scheduledOwed, cur)} owed by the schedule`));
  if (d.instalmentSplit) console.log(row('Interest in last instalment', `${money(d.instalmentSplit.interest, cur)} of ${money(d.instalmentSplit.payment, cur)} (${d.instalmentSplit.date}), not entered yet`));
  if (d.payFrom) console.log(row('Pay from', d.payFrom.accountName));
  if (d.milestones?.length) console.log(row('Milestones', d.milestones.join(', ')));
  console.log('');
}

// ── Statements (arc 1.0.50) ──────────────────────────────────

function learnedText(l: any): string {
  if (!l) return colors.muted('not learned yet (needs two statements)');
  const due = !l.due ? 'due day not learned' : l.due.kind === 'day' ? `due on the ${l.due.day}` : `due ${l.due.days} days after`;
  const wk = l.weekend === 'next_business_day' ? ', moved to Monday off a weekend' : l.weekend === 'previous_business_day' ? ', moved to Friday off a weekend' : '';
  return `statement on the ${l.statementDay}, ${due}${wk}`;
}

function reconciledText(state: string | null | undefined, diff?: number | null, cur?: string | null): string {
  if (state === 'matches') return colors.success('matches the bank ✓');
  if (state === 'off') return colors.warning(`off by ${money(Math.abs(diff ?? 0), cur)}`);
  return colors.muted('—');
}

function paymentDueText(p: any): string {
  const left = p.left !== p.owed ? colors.muted(` (the statement asked ${money(p.owed, p.currency)}; ${money(p.owed - p.left, p.currency)} paid since)`) : '';
  const grace = p.graceLostFrom ? colors.warning(' · interest runs on new purchases too') : '';
  return `${money(p.left, p.currency)} by ${p.due}${left}${grace}`;
}

export function printStatementAccounts(list: any[]) {
  console.log(header(`Statements (${list.length})`));
  if (list.length === 0) {
    console.log(`  ${colors.muted('No statements filed yet. Forward a card or bank statement to your Receipt Inbox and arc files it on your phone.')}\n`);
    return;
  }
  printTable(list.map((a: any) => ({
    account: a.closed ? `${a.accountName} ${colors.muted('(closed)')}` : a.accountName,
    kind: a.kind,
    filed: String(a.statements),
    newest: a.newest?.end ?? colors.muted('—'),
    closing: money(a.newest?.closing, a.newest?.currency),
    bank: reconciledText(a.newest?.reconciled, a.newest?.offBy, a.newest?.currency),
    auto: a.autoFile ? 'on' : colors.warning('off'),
    'pay by': a.paymentDue ? `${money(a.paymentDue.left, a.paymentDue.currency)} · ${a.paymentDue.due}` : colors.muted('—'),
  })));
  for (const a of list) {
    if (a.missing) console.log(row(a.accountName, colors.warning(`the statement of ${a.missing} hasn't arrived`)));
  }
  console.log('');
}

export function printStatementDetail(d: any) {
  console.log(header(`Statements · ${d.accountName} · ${d.kind}`));
  console.log(row('Files on its own', d.autoFile ? 'yes' : colors.warning('no: statements wait for a look')));
  console.log(row('Cycle', learnedText(d.learned)));
  if (d.learnedFields?.length) console.log(row('Learned on the card', d.learnedFields.join(', ')));
  if (d.paymentDue) {
    console.log(row('Pay', paymentDueText(d.paymentDue)));
    if (d.paymentDue.payFrom) console.log(row('Paid from last time', d.paymentDue.payFrom.name));
  }
  if (d.missing) console.log(row('Missing', colors.warning(`the statement of ${d.missing} hasn't arrived`)));
  if (d.fxMarkup) console.log(row('Foreign markup', `${(d.fxMarkup.markup * 100).toFixed(1)}% (from ${d.fxMarkup.statements} statements)`));
  if (d.statementsList.length) {
    console.log(subheader('Filed'));
    printTable([...d.statementsList].reverse().map((s: any) => ({
      period: `${s.start ?? '…'} → ${s.end}`,
      source: s.source === 'import' ? 'filed' : s.source,
      opening: money(s.opening, s.currency),
      closing: money(s.closing, s.currency),
      bank: reconciledText(s.reconciled?.state, s.reconciled?.diff, s.currency),
      rows: s.source === 'import' ? `+${s.rows.added} ✓${s.rows.cleared} 🔒${s.rows.locked}${s.rows.updated ? ` fx${s.rows.updated}` : ''}${s.rows.linked ? ` ⇄${s.rows.linked}` : ''}` : colors.muted('—'),
      'undo keeps': s.undo ? String(s.undo.kept) : colors.muted('—'),
    })));
  } else {
    console.log(`  ${colors.muted('No statements filed.')}`);
  }
  if (d.projected?.length) {
    console.log(subheader('Ahead'));
    const label: Record<string, string> = { statement: 'statement', due: 'due', annual_fee: 'annual fee', promo_end: 'promo ends', loan_end: 'last instalment' };
    for (const p of d.projected.slice(0, 8)) console.log(row(p.date, label[p.kind] ?? p.kind));
  }
  if (d.loanSchedule?.length) {
    const next = d.loanSchedule[0];
    console.log(row('Next instalment', `${next.date}: ${formatCurrency(next.principal)} principal, ${formatCurrency(next.interest)} interest`));
  }
  if (d.fees) printFeesBody(d.fees);
  console.log('');
}

function printFeesBody(f: any) {
  if (f.ledger) console.log(row('Fees, 12 months', `${money(f.ledger.total, f.currency)} · ${f.ledger.count} charges${f.ledger.tax ? ` · ${money(f.ledger.tax, f.currency)} of it tax` : ''}`));
  for (const a of f.asks) {
    const why = a.why === 'grace'
      ? `paid ${a.daysLate} day${a.daysLate === 1 ? '' : 's'} after ${a.due}: inside the bank's 3 days`
      : 'your first late fee in a year, and the card is paid in full since';
    console.log(row(`Ask back ${a.date}`, `${money(a.amount, f.currency)} ${colors.muted(a.text)} · ${why} ${colors.muted(`(${a.feeId})`)}`));
  }
}

export function printStatementFees(list: any[]) {
  console.log(header('Fees'));
  if (list.length === 0) {
    console.log(`  ${colors.muted('No fees to show: none in the last 12 months on accounts with a statement filed, and none worth asking back.')}\n`);
    return;
  }
  for (const f of list) {
    console.log(subheader(f.accountName));
    printFeesBody(f);
  }
  console.log('');
}

export function printDebtPayoff(p: any) {
  const cur = p.currency;
  console.log(header(`Payoff · ${p.accountName}`));
  console.log(row('Owed', money(p.owed, cur)));
  console.log(row('Rate', p.rate != null ? `${p.rate}% a year` : colors.muted('not set (no interest counted)')));
  console.log(row('Payment', `${money(p.payment, cur)} a month`));
  if (p.run) console.log(row('At that pace', `${p.run.months} months · ${money(p.run.interest, cur)} interest · last payment ${p.run.payoffMonth}`));
  else if (p.neverClears) console.log(row('At that pace', colors.warning('never clears: the payment does not beat the interest')));
  if (p.payMore) {
    console.log(row(`+${formatCurrency(p.payMore.extra)} a month`, `${p.payMore.monthsSooner} months sooner · ${money(p.payMore.interestSaved, cur)} saved · ${p.payMore.payoffMonth}`));
  }
  if (p.prepay) {
    console.log(row(`${formatCurrency(p.prepay.lump)} once, keep the payment`, `${p.prepay.sooner.monthsSooner} months sooner · ${money(p.prepay.sooner.interestSaved, cur)} saved`));
    console.log(row(`${formatCurrency(p.prepay.lump)} once, keep the end`, `${money(p.prepay.lower.payment, cur)} a month (${money(p.prepay.lower.paymentDrop, cur)} less) · ${money(p.prepay.lower.interestSaved, cur)} saved`));
  }
  console.log('');
}

export function printIous(l: any) {
  if (!l.account) {
    console.log(header('IOUs'));
    console.log(`  ${colors.muted('No IOUs ledger in this budget. The arc app makes one the first time you split with someone.')}\n`);
    return;
  }
  console.log(header(`IOUs · ${l.account.name}`));
  if (l.people.length === 0) {
    console.log(`  ${colors.muted('Nobody owes anything.')}\n`);
    return;
  }
  printTable(l.people.map((p: any) => ({
    person: p.person,
    balance: p.balance > 0 ? colors.success(`owes you ${formatCurrency(p.balance)}`) : p.balance < 0 ? colors.warning(`you owe ${formatCurrency(-p.balance)}`) : colors.muted('square'),
    open: String(p.open.length),
    last: p.lastDate,
  })));
  console.log(row('Owed to you', formatCurrency(l.owedToYou)));
  console.log(row('You owe', formatCurrency(l.youOwe)));
  if (l.groups.length) console.log(row('Groups', l.groups.map((g: any) => `${g.name} (${g.people.length})`).join(', ')));
  console.log('');
}

export function printDebtPlan(p: any) {
  console.log(header('Pay here first'));
  if (p.debtsOwing === 0) {
    console.log(`  ${colors.muted('Nothing owed.')}\n`);
    return;
  }
  printTable(p.debts.map((d: any) => ({
    account: d.accountName,
    owed: formatCurrency(d.owed),
    rate: d.rate != null ? `${d.rate}%` : colors.muted('—'),
    minimum: `${formatCurrency(d.minimum)}${d.minimumEstimated ? colors.muted(' (est.)') : ''}`,
  })));
  console.log(row('Each month', formatCurrency(p.monthlyTotal)));
  for (const plan of p.plans) {
    console.log(subheader(plan.method === 'avalanche' ? 'Avalanche (highest rate first)' : 'Snowball (smallest first)'));
    if (!plan.available) {
      console.log(`  ${colors.muted(plan.reason)}`);
      continue;
    }
    console.log(row('Pay here first', plan.first.accountName));
    console.log(row('Order', plan.order.map((o: any) => o.accountName).join(' → ')));
    console.log(row('Debt-free', `${plan.debtFreeMonth} · ${plan.months} months · ${formatCurrency(plan.interest)} interest`));
  }
  console.log('');
}

function describeRepeat(months: number | null): string {
  if (months == null) return 'once';
  if (months === 12) return 'every year';
  return months === 1 ? 'every month' : `every ${months} months`;
}

export function printCategoryTemplates(list: any[]) {
  console.log(header(`Category templates (${list.length})`));
  if (list.length === 0) {
    console.log(`  ${colors.muted('No category templates. Set a savings target with `arc categories template-set --category <name> --target <amount> --by YYYY-MM`.')}\n`);
    return;
  }
  printTable(list.map((t: any) => ({
    category: t.categoryName,
    group: t.groupName ?? colors.muted('—'),
    target: t.sinkingFund ? formatCurrency(t.sinkingFund.targetCents) : colors.muted('—'),
    by: t.sinkingFund?.byMonth ?? colors.muted('—'),
    repeat: t.sinkingFund ? describeRepeat(t.sinkingFund.repeatEveryMonths) : colors.muted('—'),
    lines: t.directives.length,
    editable: t.editable ? 'yes' : colors.warning('in Actual'),
  })));
  const locked = list.filter((t: any) => !t.editable);
  if (locked.length > 0) {
    console.log(`  ${colors.muted(`${locked.length} ${locked.length === 1 ? 'category has' : 'categories have'} templates arc will not rewrite — edit those in Actual.`)}\n`);
  }
}

export function printTemplateWrite(result: any) {
  console.log(header(`Savings target — ${result.categoryName}`));
  console.log(row('Template', result.templateLine));
  if (result.goalLine) console.log(row('Goal', result.goalLine));
  console.log(row('Changed', result.changed ? 'yes' : colors.muted('no (already set)')));
  console.log('');
}

// ── Group splits ──────────────────────────────────────────────

export function printSplitGroups(groups: any[]) {
  console.log(header(`Group splits (${groups.length})`));
  if (groups.length === 0) {
    console.log(`  ${colors.muted('No splits yet. Share one with `arc splits create --transaction <id> --people ...`.')}\n`);
    return;
  }
  for (const g of groups) {
    const payee = g.payeeName || colors.muted('(no payee)');
    console.log(
      `  ${colors.secondary(g.gid)}  ${g.date}  ${payee}  ` +
      `${formatCurrency(Math.abs(g.transactionAmount))}  ${colors.muted(g.accountName)}`
    );
    for (const p of g.people) {
      const state = p.status === 'paid'
        ? colors.success(`settled${p.settled ? ' ' + p.settled : ''}`)
        : colors.warning('open');
      console.log(
        `      ${p.person.padEnd(16)} ${String(Math.round(p.share * 100)).padStart(3)}%  ` +
        `${formatCurrency(p.amt).padStart(12)}  ${state}`
      );
    }
    if (g.owedTotal > 0) {
      console.log(`      ${colors.muted('still owed:')} ${formatCurrency(g.owedTotal)}`);
    }
    console.log('');
  }
}

export function printReceivables(balances: any[]) {
  console.log(header(`Receivables (${balances.length})`));
  if (balances.length === 0) {
    console.log(`  ${colors.muted('Nobody owes you anything.')}\n`);
    return;
  }
  printTable(balances.map((b: any) => ({
    person: b.person,
    owes: formatCurrency(b.open),
    settled: formatCurrency(b.paid),
    splits: b.splitCount,
  })));
  const total = balances.reduce((s: number, b: any) => s + b.open, 0);
  console.log(`\nTotal outstanding: ${formatCurrency(total)}`);
}

// ── Refunds ───────────────────────────────────────────────────

export function printRefunds(rows: any[]) {
  console.log(header(`Refunded transactions (${rows.length})`));
  if (rows.length === 0) {
    console.log(`  ${colors.muted('No refunded transactions in this range.')}\n`);
    return;
  }
  printTable(rows.map((r: any) => ({
    date: r.date,
    payee: r.payee_name || '—',
    account: r.accountName,
    original: formatCurrency(r.originalAmount),
    direction: r.direction,
    refunded: r.refundedOn,
  })));
  const total = rows.reduce((s: number, r: any) => s + Math.abs(r.originalAmount), 0);
  console.log(`\nTotal refunded: ${formatCurrency(total)}`);
}

// ── Reconcile ─────────────────────────────────────────────────

function statementLineLabel(line: any): string {
  return line.payee || line.description || '—';
}

export function printStatementReport(report: any) {
  const period = report.period ? ` · ${report.period.start} → ${report.period.end}` : '';
  console.log(header(`Statement vs ${report.accountName}${period}`));
  const s = report.summary;
  console.log(row('Lines', String(s.lines)));
  console.log(row('Matched', colors.success(String(s.matched))));
  console.log(row('Missing in arc', s.missingInLedger ? colors.warning(String(s.missingInLedger)) : '0'));
  console.log(row('Amount differs', s.amountMismatches ? colors.warning(String(s.amountMismatches)) : '0'));
  console.log(row('Ambiguous', s.ambiguous ? colors.warning(String(s.ambiguous)) : '0'));
  console.log(row('Extra in arc', s.extraInLedger ? colors.warning(String(s.extraInLedger)) : '0'));
  if (report.currency) console.log(row('Statement currency', report.currency));

  if (report.balance) {
    const point = (p: any) => p == null
      ? colors.muted('—')
      : p.matches
        ? colors.success(`${sym.check} ${formatCurrency(p.statementCents)}`)
        : colors.warning(`${formatCurrency(p.statementCents)} vs arc ${formatCurrency(p.ledgerCents)} (${formatCurrency(p.differenceCents)})`);
    console.log(row('Opening balance', point(report.balance.opening)));
    console.log(row('Closing balance', point(report.balance.closing)));
  }

  if (report.missingInLedger.length) {
    console.log(subheader('Missing in arc (apply imports these)'));
    printTable(report.missingInLedger.map((l: any) => ({
      date: l.date,
      payee: statementLineLabel(l),
      amount: formatCurrency(l.amount),
    })));
  }
  if (report.amountMismatches.length) {
    console.log(subheader('Amount differs (left alone; fix by hand)'));
    printTable(report.amountMismatches.map((m: any) => ({
      date: m.line.date,
      statement: `${statementLineLabel(m.line)} ${formatCurrency(m.statementCents)}`,
      arc: `${m.transaction.payee_name || '—'} ${formatCurrency(m.ledgerCents)}`,
      difference: formatCurrency(m.differenceCents),
    })));
  }
  if (report.ambiguous.length) {
    console.log(subheader('Ambiguous (several arc rows fit equally; left alone)'));
    printTable(report.ambiguous.map((a: any) => ({
      date: a.line.date,
      payee: statementLineLabel(a.line),
      amount: formatCurrency(a.line.amount),
      'best guess': `${a.transaction.date} ${a.transaction.payee_name || '—'}`,
    })));
  }
  if (report.extraInLedger.length) {
    console.log(subheader('In arc but not on the statement'));
    printTable(report.extraInLedger.map((t: any) => ({
      date: t.date,
      payee: t.payee_name || (t.transfer ? 'transfer' : '—'),
      amount: formatCurrency(t.amount),
      cleared: t.reconciled ? 'reconciled' : t.cleared ? 'yes' : 'no',
    })));
  }
  if (!report.missingInLedger.length && !report.amountMismatches.length && !report.ambiguous.length && !report.extraInLedger.length) {
    console.log(`\n  ${colors.success(sym.check + ' Everything on the statement is in arc, and nothing extra.')}`);
  } else if (report.missingInLedger.length || report.matched.some((m: any) => !m.transaction.cleared)) {
    console.log(`\n  ${colors.muted('Run `arc reconcile apply` with the same flags to import the missing lines and clear the matches.')}`);
  }
  console.log('');
}

export function printStatementApplied(res: any) {
  console.log(header(`Statement applied to ${res.accountName}`));
  console.log(row('Imported', String(res.imported)));
  if (res.updatedByImport) console.log(row('Merged by import', String(res.updatedByImport)));
  console.log(row('Marked cleared', String(res.cleared)));
  console.log(row('Already cleared', String(res.alreadyCleared)));
  const left = res.skipped.amountMismatches + res.skipped.ambiguous;
  if (left) {
    console.log(row('Left for you', colors.warning(`${res.skipped.amountMismatches} amount mismatch(es), ${res.skipped.ambiguous} ambiguous`)));
    console.log(`  ${colors.muted('`arc reconcile statement` with the same flags lists them.')}`);
  }
  for (const e of res.importErrors) console.log(`  ${colors.error(sym.cross + ' ' + e)}`);
  console.log('');
}

export function printDuplicateGroups(groups: any[]) {
  console.log(header(`Likely duplicates (${groups.length})`));
  if (groups.length === 0) {
    console.log(`  ${colors.muted('None found. Widen the search with --since YYYY-MM-DD or lower --min-score.')}\n`);
    return;
  }
  for (const g of groups) {
    console.log(subheader(`${g.accountName} · score ${g.score} · ${g.reasons.join(', ')}`));
    printTable(g.transactions.map((t: any) => ({
      id: t.id,
      date: t.date,
      payee: t.payee_name || '—',
      amount: formatCurrency(t.amount),
      cleared: t.reconciled ? 'reconciled' : t.cleared ? 'yes' : 'no',
    })));
  }
  console.log(`\n  ${colors.muted('Delete the extra copy with `arc transactions delete --id <id>`.')}\n`);
}

export function printAccountReconciled(res: any) {
  console.log(header(`Reconciled ${res.accountName}`));
  console.log(row('Cleared balance', formatCurrency(res.clearedBalance)));
  console.log(row('Locked', `${res.locked} transaction(s)`));
  console.log(row('Last reconciled', new Date(Number(res.lastReconciled)).toISOString()));
  console.log('');
}
