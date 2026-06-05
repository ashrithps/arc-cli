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
  console.log(cmd('categories', 'List/manage categories'));
  console.log(cmd('payees', 'List/manage payees'));
  console.log(cmd('tags', 'List/add/update/delete tags'));
  console.log(cmd('rules', 'List/manage rules'));
  console.log(cmd('schedules', 'List/manage schedules'));
  console.log(cmd('budgets', 'List/switch budgets and manage budget amounts'));
  console.log(cmd('query', 'Smart queries (spending, uncategorized)'));
  console.log(cmd('portfolio', 'Investment holdings and trade activity (read-only)'));
  console.log(cmd('backup', 'List/clean backups'));
  console.log('');

  console.log(chalk.bold.white('  Flags'));
  console.log(divider(50));
  console.log(cmd('--json', 'Machine-readable JSON output'));
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
