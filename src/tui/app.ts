#!/usr/bin/env node

import 'dotenv/config';
process.env.ARC_DISABLE_OUTPUT_FILTER = '1';

// Suppress @actual-app/api console noise
const _log = console.log, _err = console.error, _warn = console.warn;
const noop = (..._a: any[]) => {};
console.log = noop; console.error = noop; console.warn = noop;

import blessed from 'blessed';
import contrib from 'blessed-contrib';
type ActualClientType = typeof import('../client.js').ActualClient;

const logBuffer: string[] = [];
console.log = (...a: any[]) => logBuffer.push(a.join(' '));
console.error = (...a: any[]) => logBuffer.push('[ERR] ' + a.join(' '));
console.warn = (...a: any[]) => logBuffer.push('[WARN] ' + a.join(' '));

// Catch crashes and write to file before exit
import * as fs from 'fs';
process.on('uncaughtException', (err) => {
  try {
    fs.writeFileSync('/tmp/arc-crash.log', `${err.stack}\n\nLog buffer:\n${logBuffer.join('\n')}`);
  } catch {}
  // Don't exit — blessed can recover from most errors
});
process.on('unhandledRejection', (err: any) => {
  // Don't exit — @actual-app/api throws internal rejections it handles later
  logBuffer.push('[REJECTION] ' + (err?.message || err));
});

// ── Theme ─────────────────────────────────────────────────────

const T = {
  bg: '#0c0c14',
  fg: '#e0e0e8',
  border: '#2a2a3a',
  borderHi: '#6c5ce7',
  accent: '#a78bfa',
  accent2: '#22d3ee',
  green: '#34d399',
  red: '#f87171',
  yellow: '#fbbf24',
  orange: '#fb923c',
  pink: '#f472b6',
  blue: '#60a5fa',
  purple: '#a78bfa',
  muted: '#6b7280',
  dim: '#374151',
  panelBg: '#0f0f1a',
  headerBg: '#13132a',
  statusBg: '#13132a',
};

// ── Icons ─────────────────────────────────────────────────────

const IC = {
  logo: '◆',
  connected: '●',
  disconnected: '○',
  bank: '🏦',
  card: '💳',
  wallet: '👛',
  savings: '🏦',
  invest: '📈',
  crypto: '₿',
  cash: '💵',
  loan: '📋',
  goal: '🎯',
  check: '✓',
  cross: '✗',
  dot: '•',
  arrow: '→',
  arrowUp: '▲',
  arrowDown: '▼',
  split: '⊞',
  star: '★',
  sparkle: '✦',
  bar: '█',
  barEmpty: '░',
  pipe: '│',
  corner: '└',
  tee: '├',
  hline: '─',
  section: '▸',
  chevron: '›',
};

function accountIcon(name: string, type?: string): string {
  const n = name.toLowerCase();
  if (type === 'credit' || n.includes('credit')) return IC.card;
  if (n.includes('crypto') || n.includes('usdt') || n.includes('usdc') || n.includes('ether') || n.includes('digital asset')) return IC.crypto;
  if (n.includes('cash')) return IC.cash;
  if (n.includes('loan') || n.includes('advance')) return IC.loan;
  if (n.includes('saving')) return IC.savings;
  if (n.includes('invest') || n.includes('portfolio') || n.includes('ibkr')) return IC.invest;
  if (n.includes('wallet') || n.includes('ready')) return IC.wallet;
  if (n.includes('car') || n.includes('vacation') || n.includes('🎯')) return IC.goal;
  return IC.bank;
}

// ── State ─────────────────────────────────────────────────────

interface AppState {
  connected: boolean;
  budgetName: string;
  budgetFiles: any[];
  accounts: any[];
  accountBalances: Record<string, number>;
  transactions: any[];
  categories: any[];
  payeeMap: Record<string, string>;
  budgetMonths: string[];
  budgetData: any | null;
  selectedAccount: number;
  selectedView: 'accounts' | 'transactions' | 'budget' | 'categories' | 'payees';
  payees: any[];
  statusMessage: string;
  loading: boolean;
  loadingTxns: boolean;
}

const state: AppState = {
  connected: false,
  budgetName: '',
  budgetFiles: [],
  accounts: [],
  accountBalances: {},
  transactions: [],
  categories: [],
  payeeMap: {},
  budgetMonths: [],
  budgetData: null,
  selectedAccount: 0,
  selectedView: 'accounts',
  payees: [],
  loadingTxns: false,
  statusMessage: '',
  loading: true,
};

// ── Screen ────────────────────────────────────────────────────

const screen = blessed.screen({
  smartCSR: true,
  title: 'arc',
  fullUnicode: true,
  dockBorders: true,
});

// ── Header ────────────────────────────────────────────────────

const header = blessed.box({
  top: 0, left: 0, width: '100%', height: 3,
  tags: true,
  style: { bg: T.headerBg, fg: T.fg },
});

function updateHeader() {
  const server = client?.getConfig()?.serverURL?.replace('https://', '') || '...';
  const budgetLabel = state.budgetName ? `{${T.accent2}-fg}${state.budgetName}{/${T.accent2}-fg}` : '';
  const conn = state.connected
    ? `{${T.green}-fg}${IC.connected}{/${T.green}-fg} ${budgetLabel} {${T.muted}-fg}${IC.arrow} ${server}{/${T.muted}-fg}`
    : `{${T.red}-fg}${IC.disconnected} disconnected{/${T.red}-fg}`;

  const tab = (key: string, label: string, view: string) => {
    const active = state.selectedView === view;
    return active
      ? `{${T.accent}-fg}{bold}{underline}${key}{/underline}${label}{/bold}{/${T.accent}-fg}`
      : `{${T.muted}-fg}${key}${label}{/${T.muted}-fg}`;
  };

  const logo = `{bold}{${T.accent}-fg} ${IC.logo} arc{/${T.accent}-fg}{/bold}`;
  const tabs = `  ${tab('A', 'ccounts', 'accounts')}  ${tab('T', 'xns', 'transactions')}  ${tab('B', 'udget', 'budget')}  ${tab('C', 'ategories', 'categories')}  ${tab('P', 'ayees', 'payees')}`;

  header.setContent(`${logo}  ${conn}\n${tabs}`);
}

// ── Sidebar ───────────────────────────────────────────────────

const sidebar = blessed.list({
  top: 3, left: 0, width: '28%', height: '100%-6',
  label: ` ${IC.sparkle} Accounts `,
  border: { type: 'line', fg: T.border },
  scrollable: true, mouse: true, keys: false, vi: false, tags: true,
  style: {
    bg: T.panelBg, fg: T.fg,
    border: { fg: T.border },
    label: { fg: T.accent, bold: true },
    selected: { bg: T.borderHi, fg: '#ffffff', bold: true },
    item: { fg: T.fg },
  },
  scrollbar: { ch: IC.pipe, style: { fg: T.dim } },
});

let sidebarAccountIndex: number[] = [];

function fmtBal(cents: number, isCard: boolean = false): string {
  const val = cents / 100;
  const abs = Math.abs(val);
  let str: string;
  if (abs >= 1000) str = `$${(abs/1000).toFixed(1)}k`;
  else str = `$${abs.toFixed(0)}`;

  if (isCard) {
    return val < 0 ? `{${T.red}-fg}${str}{/${T.red}-fg}` : val > 0 ? `{${T.green}-fg}${str}{/${T.green}-fg}` : `{${T.dim}-fg}$0{/${T.dim}-fg}`;
  }
  return val > 0 ? `{${T.green}-fg}${str}{/${T.green}-fg}` : val < 0 ? `{${T.red}-fg}-${str}{/${T.red}-fg}` : `{${T.dim}-fg}$0{/${T.dim}-fg}`;
}

function updateSidebar() {
  const mkGroup = (filter: (a: any) => boolean) =>
    state.accounts.map((a: any, i: number) => ({ ...a, _idx: i })).filter(filter)
      .sort((a: any, b: any) => {
        const ac = (a.type === 'credit' || a.name.toLowerCase().includes('credit')) ? 0 : 1;
        const bc = (b.type === 'credit' || b.name.toLowerCase().includes('credit')) ? 0 : 1;
        return ac !== bc ? ac - bc : a.name.localeCompare(b.name);
      });

  const onBudget = mkGroup((a: any) => !a.offbudget && !a.closed);
  const offBudget = mkGroup((a: any) => a.offbudget && !a.closed);
  const closed = mkGroup((a: any) => a.closed);

  const items: string[] = [];
  sidebarAccountIndex = [];

  // "All Accounts" virtual entry at top
  items.push(`{bold}{${T.accent}-fg} ${IC.star} All Accounts{/${T.accent}-fg}{/bold}`);
  sidebarAccountIndex.push(-2); // -2 = All Accounts

  const addSection = (label: string, color: string, accts: any[]) => {
    if (accts.length === 0) return;
    if (items.length > 0) { items.push(''); sidebarAccountIndex.push(-1); }
    items.push(`{bold}{${color}-fg} ${IC.section} ${label}{/${color}-fg}{/bold}`);
    sidebarAccountIndex.push(-1);

    for (const a of accts) {
      const bal = state.accountBalances[a.id] || 0;
      const isCard = a.type === 'credit' || a.name.toLowerCase().includes('credit');
      const icon = accountIcon(a.name, a.type);
      const nameW = 18;
      const name = a.name.slice(0, nameW).padEnd(nameW);
      items.push(`  ${icon} ${name} ${fmtBal(bal, isCard)}`);
      sidebarAccountIndex.push(a._idx);
    }
  };

  addSection('On Budget', T.accent2, onBudget);
  addSection('Off Budget', T.yellow, offBudget);
  addSection('Closed', T.muted, closed);

  sidebar.setItems(items);
  const sidebarIdx = sidebarAccountIndex.indexOf(state.selectedAccount);
  if (sidebarIdx >= 0) sidebar.select(sidebarIdx);
}

// ── Transaction List (selectable rows) ────────────────────────

const txnList = blessed.list({
  top: 3, left: '28%', width: '72%', height: '100%-6',
  label: ' Transactions ',
  border: { type: 'line', fg: T.border },
  scrollable: true, mouse: true, keys: false, vi: false, tags: true,
  style: {
    bg: T.panelBg, fg: T.fg,
    border: { fg: T.border },
    label: { fg: T.accent2, bold: true },
    selected: { bg: '#1e1e3a', fg: '#ffffff', bold: true },
    item: { fg: T.fg },
  },
  scrollbar: { ch: IC.pipe, style: { fg: T.dim } },
});

// The main panel is used for budget/categories (non-selectable content)
const mainPanel = blessed.box({
  top: 3, left: '28%', width: '72%', height: '100%-6',
  label: ' Info ',
  border: { type: 'line', fg: T.border },
  scrollable: true, mouse: true, keys: true, vi: true, tags: true,
  hidden: true,
  style: {
    bg: T.panelBg, fg: T.fg,
    border: { fg: T.border },
    label: { fg: T.accent2, bold: true },
  },
  scrollbar: { ch: IC.pipe, style: { fg: T.dim } },
});

// ── Budget List (selectable rows for editing) ────────────────

const budgetList = blessed.list({
  top: 3, left: '28%', width: '72%', height: '100%-6',
  label: ` ${IC.star} Budget `,
  border: { type: 'line', fg: T.border },
  scrollable: true, mouse: true, keys: false, vi: false, tags: true,
  hidden: true,
  style: {
    bg: T.panelBg, fg: T.fg,
    border: { fg: T.border },
    label: { fg: T.accent2, bold: true },
    selected: { bg: '#1e1e3a', fg: '#ffffff', bold: true },
    item: { fg: T.fg },
  },
  scrollbar: { ch: IC.pipe, style: { fg: T.dim } },
});

// Maps budget list row → { categoryId, month } for editing
let budgetListIndex: Array<{ categoryId: string; name: string } | null> = [];

// Category map for resolving IDs to names
let categoryMap: Record<string, string> = {};

function buildCategoryMap() {
  categoryMap = {};
  for (const g of state.categories) {
    for (const c of (g as any).categories || []) {
      categoryMap[c.id] = c.name;
    }
  }
}

// Track which list items map to real transactions (for editing)
let txnListIndex: number[] = []; // maps list row → index in state.transactions (-1 for headers)

function formatAmount(cents: number): string {
  // Currency-agnostic: Actual Budget is currency-agnostic, so the TUI
  // renders plain decimals without a currency symbol. See src/ui/theme.ts
  // for the CLI-side rationale.
  const abs = Math.abs(cents / 100);
  const str = abs >= 1000 ? abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : abs.toFixed(2);
  if (cents > 0) return `{${T.green}-fg}+${str}{/${T.green}-fg}`;
  if (cents < 0) return `{${T.red}-fg}-${str}{/${T.red}-fg}`;
  return `{${T.dim}-fg}${str}{/${T.dim}-fg}`;
}

function showTxnView() {
  txnList.show(); mainPanel.hide(); budgetList.hide();
}
function showInfoView() {
  txnList.hide(); mainPanel.show(); budgetList.hide();
}
function showBudgetView() {
  txnList.hide(); mainPanel.hide(); budgetList.show();
}

function updateMainPanel() {
  switch (state.selectedView) {
    case 'accounts': case 'transactions':
      showTxnView(); renderTransactions(); break;
    case 'budget':
      showBudgetView(); renderBudget(); break;
    case 'categories':
      showInfoView(); renderCategories(); break;
    case 'payees':
      showInfoView(); renderPayees(); break;
  }
  screen.render();
}

function renderTransactions() {
  const account = state.accounts[state.selectedAccount];
  const icon = account ? accountIcon(account.name, account.type) : '';
  txnList.setLabel(` ${icon} ${account?.name || '...'} `);

  if (state.loadingTxns) {
    txnList.setItems([`  {${T.accent}-fg}${IC.sparkle} Loading...{/${T.accent}-fg}`]);
    txnListIndex = [-1];
    return;
  }

  if (state.transactions.length === 0) {
    txnList.setItems([`  {${T.muted}-fg}No transactions{/${T.muted}-fg}`]);
    txnListIndex = [-1];
    return;
  }

  const pw = (txnList as any).width ? Number((txnList as any).width) - 4 : 75;
  const dateW = 8;
  const amtW = 12;
  const remaining = pw - dateW - amtW - 3;
  const payeeW = Math.max(12, Math.floor(remaining * 0.45));
  const catW = Math.max(10, Math.floor(remaining * 0.35));
  const notesW = Math.max(6, remaining - payeeW - catW);

  const items: string[] = [];
  txnListIndex = [];

  // Header
  items.push(`{bold}{${T.muted}-fg} ${'Date'.padEnd(dateW)}${'Payee'.padEnd(payeeW)}${'Category'.padEnd(catW)}${'Notes'.padEnd(notesW)}${'Amount'.padStart(amtW)}{/${T.muted}-fg}{/bold}`);
  txnListIndex.push(-1);
  items.push(`{${T.dim}-fg} ${IC.hline.repeat(pw - 2)}{/${T.dim}-fg}`);
  txnListIndex.push(-1);

  // Group by month with separators
  let lastMonth = '';

  for (let i = 0; i < state.transactions.length; i++) {
    const t = state.transactions[i];
    const month = (t.date || '').slice(0, 7); // YYYY-MM

    if (month !== lastMonth) {
      lastMonth = month;
      const monthNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const [y, m] = month.split('-');
      const label = `${monthNames[parseInt(m)]} ${y}`;
      if (items.length > 2) { // not first
        items.push(`{${T.dim}-fg} ${IC.hline.repeat(pw - 2)}{/${T.dim}-fg}`);
        txnListIndex.push(-1);
      }
      items.push(`{bold}{${T.accent2}-fg}  ${IC.section} ${label}{/${T.accent2}-fg}{/bold}`);
      txnListIndex.push(-1);
    }

    const date = (t.date || '').slice(5).padEnd(dateW); // MM-DD
    let payee = t.payee_name || t.imported_payee || '';
    if (!payee && t.payee) payee = state.payeeMap[t.payee] || '';
    payee = payee.slice(0, payeeW - 1).padEnd(payeeW);

    // Resolve category name — transfers show as → Account
    let cat = '';
    let catColor = T.dim;
    if (t.transfer_id) {
      // It's a transfer — show destination account name
      const destPayee = t.payee ? state.payeeMap[t.payee] : '';
      cat = destPayee ? `→ ${destPayee}` : '→ transfer';
      catColor = T.blue;
    } else if (t.category) {
      cat = categoryMap[t.category] || '';
      catColor = cat ? T.accent : T.dim;
    }
    cat = (cat || '—').slice(0, catW - 1).padEnd(catW);

    // Extract clean notes
    let notes = '';
    if (t.notes) {
      const b = t.notes.indexOf('•');
      if (b > 0) notes = t.notes.slice(b + 1).trim();
      // Strip generic "XXX (FX rate: N)" FX-rule prefixes without a • separator.
      else if (!/\b[A-Z]{3}\s*\(FX rate:/.test(t.notes)) notes = t.notes;
    }
    notes = notes.slice(0, notesW - 1).padEnd(notesW);

    const amt = formatAmount(t.amount || 0);
    const clr = t.cleared ? `{${T.green}-fg}${IC.check}{/${T.green}-fg}` : ` `;

    if (t.is_child) continue; // skip children, shown under parent

    if (t.is_parent) {
      // Split parent — show with ✂️ indicator
      items.push(` ${date}${payee}{${catColor}-fg}${cat}{/${catColor}-fg}{${T.dim}-fg}${notes}{/${T.dim}-fg}${amt} ${clr}{${T.purple}-fg}✂️{/${T.purple}-fg}`);
      txnListIndex.push(i);

      // Show subtransactions as indented children
      const subs = t.subtransactions || [];
      for (let si = 0; si < subs.length; si++) {
        const sub = subs[si];
        const isLast = si === subs.length - 1;
        const prefix = isLast ? IC.corner : IC.tee;
        const subCat = sub.category ? (categoryMap[sub.category] || '') : '—';
        const subNotes = (sub.notes || '').slice(0, notesW - 3);
        const subAmt = formatAmount(sub.amount || 0);
        items.push(`{${T.dim}-fg}   ${prefix}{/${T.dim}-fg} ${''.padEnd(dateW - 3)}{${T.muted}-fg}${''.padEnd(payeeW)}{/${T.muted}-fg}{${T.accent}-fg}${subCat.slice(0, catW - 1).padEnd(catW)}{/${T.accent}-fg}{${T.dim}-fg}${subNotes.padEnd(notesW)}{/${T.dim}-fg}${subAmt}`);
        txnListIndex.push(-1); // subtransaction rows not directly editable
      }
    } else {
      items.push(` ${date}${payee}{${catColor}-fg}${cat}{/${catColor}-fg}{${T.dim}-fg}${notes}{/${T.dim}-fg}${amt} ${clr}`);
      txnListIndex.push(i);
    }
  }

  // Summary
  const totalIn = state.transactions.filter((t: any) => t.amount > 0).reduce((s: number, t: any) => s + t.amount, 0);
  const totalOut = state.transactions.filter((t: any) => t.amount < 0).reduce((s: number, t: any) => s + t.amount, 0);
  const net = totalIn + totalOut;

  items.push(`{${T.dim}-fg} ${IC.hline.repeat(pw - 2)}{/${T.dim}-fg}`);
  txnListIndex.push(-1);
  const sumPad = dateW + payeeW + catW + notesW - 2;
  items.push(` ${''.padEnd(sumPad)}${formatAmount(totalIn).padStart(amtW + 8)} {${T.green}-fg}${IC.arrowUp} in{/${T.green}-fg}`);
  txnListIndex.push(-1);
  items.push(` ${''.padEnd(sumPad)}${formatAmount(totalOut).padStart(amtW + 8)} {${T.red}-fg}${IC.arrowDown} out{/${T.red}-fg}`);
  txnListIndex.push(-1);
  items.push(` ${''.padEnd(sumPad)}${formatAmount(net).padStart(amtW + 8)} {bold}${IC.arrow} net{/bold}`);
  txnListIndex.push(-1);

  txnList.setItems(items);
}

function renderBudget() {
  const month = state.budgetMonths.length > 0 ? state.budgetMonths[state.budgetMonths.length - 1] : '?';
  budgetList.setLabel(` ${IC.star} Budget — ${month} `);

  if (!state.budgetData) {
    budgetList.setItems([`  {${T.muted}-fg}No budget data.{/${T.muted}-fg}`]);
    budgetListIndex = [null];
    return;
  }

  const items: string[] = [];
  budgetListIndex = [];
  const budget = state.budgetData;

  if (budget.toBudget != null) {
    const tbColor = budget.toBudget >= 0 ? T.green : T.red;
    items.push(`{bold}{${T.accent}-fg} ${IC.sparkle} To Budget: ${formatAmount(budget.toBudget)}{/${T.accent}-fg}{/bold}`);
    budgetListIndex.push(null);
    items.push('');
    budgetListIndex.push(null);
  }

  const pw = (budgetList as any).width ? Number((budgetList as any).width) - 4 : 70;
  const nameW = 20;
  const numW = 12;

  for (const group of budget.categoryGroups || []) {
    items.push(`{bold}{${T.purple}-fg} ${IC.section} ${group.name}{/${T.purple}-fg}{/bold}`);
    budgetListIndex.push(null);

    items.push(`{${T.dim}-fg}  ${'Category'.padEnd(nameW)}${'Budget'.padStart(numW)}${'Spent'.padStart(numW)}${'Left'.padStart(numW)}  Progress{/${T.dim}-fg}`);
    budgetListIndex.push(null);

    for (const cat of group.categories || []) {
      const budgeted = cat.budgeted || 0;
      const spent = cat.spent || 0;
      const balance = cat.balance || 0;

      const pct = budgeted !== 0 ? Math.min(Math.abs(spent) / Math.abs(budgeted), 1) : 0;
      const bw = 10;
      const filled = Math.round(pct * bw);
      const color = pct > 0.9 ? T.red : pct > 0.7 ? T.yellow : T.green;
      const bar = `{${color}-fg}${IC.bar.repeat(filled)}{/${color}-fg}{${T.dim}-fg}${IC.barEmpty.repeat(bw - filled)}{/${T.dim}-fg}`;
      const pctStr = `{${color}-fg}${Math.round(pct * 100)}%{/${color}-fg}`;

      const name = cat.name.slice(0, nameW - 2).padEnd(nameW);
      items.push(`  ${name}${formatAmount(budgeted).padStart(numW + 6)}${formatAmount(spent).padStart(numW + 6)}${formatAmount(balance).padStart(numW + 6)}  ${bar} ${pctStr}`);
      budgetListIndex.push({ categoryId: cat.id, name: cat.name });
    }
    items.push('');
    budgetListIndex.push(null);
  }

  items.push(`{${T.muted}-fg}  Space: edit budget amount  ←: back{/${T.muted}-fg}`);
  budgetListIndex.push(null);

  budgetList.setItems(items);
}

function renderCategories() {
  mainPanel.setLabel(` ${IC.sparkle} Categories `);

  const lines: string[] = [];
  for (const group of state.categories) {
    const g = group as any;
    const income = g.is_income ? ` {${T.green}-fg}[income]{/${T.green}-fg}` : '';
    lines.push(`  {bold}{${T.purple}-fg}${IC.section} ${g.name}{/${T.purple}-fg}{/bold}${income} {${T.dim}-fg}${g.id?.slice(0, 8)}{/${T.dim}-fg}`);

    const cats = g.categories || [];
    for (let i = 0; i < cats.length; i++) {
      const cat = cats[i];
      const last = i === cats.length - 1;
      const prefix = last ? IC.corner : IC.tee;
      const hidden = cat.hidden ? ` {${T.dim}-fg}[hidden]{/${T.dim}-fg}` : '';
      const inc = cat.is_income ? ` {${T.green}-fg}${IC.arrowUp}{/${T.green}-fg}` : '';
      lines.push(`    {${T.dim}-fg}${prefix}{/${T.dim}-fg} ${cat.name}${inc}${hidden} {${T.dim}-fg}${cat.id?.slice(0, 8)}{/${T.dim}-fg}`);
    }
    lines.push('');
  }

  mainPanel.setContent(lines.join('\n'));
}

function renderPayees() {
  mainPanel.setLabel(` ${IC.sparkle} Payees (${state.payees.length}) `);

  const filtered = state.payees.filter((p: any) => !p.transfer_acct);
  const transfers = state.payees.filter((p: any) => p.transfer_acct);

  const lines: string[] = [];

  // Sort alphabetically
  const sorted = [...filtered].sort((a: any, b: any) => a.name.localeCompare(b.name));

  // Group by first letter
  let lastLetter = '';
  for (const p of sorted) {
    const letter = (p.name[0] || '?').toUpperCase();
    if (letter !== lastLetter) {
      lastLetter = letter;
      if (lines.length > 0) lines.push('');
      lines.push(`  {bold}{${T.accent2}-fg}${IC.section} ${letter}{/${T.accent2}-fg}{/bold}`);
    }
    lines.push(`    {${T.muted}-fg}${IC.dot}{/${T.muted}-fg} ${p.name} {${T.dim}-fg}${p.id?.slice(0, 8)}{/${T.dim}-fg}`);
  }

  // Transfer payees section
  if (transfers.length > 0) {
    lines.push('');
    lines.push(`  {bold}{${T.blue}-fg}${IC.section} Transfer Payees (${transfers.length}){/${T.blue}-fg}{/bold}`);
    for (const p of transfers) {
      lines.push(`    {${T.blue}-fg}${IC.arrow}{/${T.blue}-fg} ${p.name} {${T.dim}-fg}→ ${p.transfer_acct?.slice(0, 8)}{/${T.dim}-fg}`);
    }
  }

  lines.push('');
  lines.push(`  {${T.muted}-fg}Total: ${filtered.length} payees + ${transfers.length} transfer payees{/${T.muted}-fg}`);

  mainPanel.setContent(lines.join('\n'));
}

// ── Status Bar ────────────────────────────────────────────────

const statusBar = blessed.box({
  bottom: 0, left: 0, width: '100%', height: 3,
  tags: true,
  style: { bg: T.statusBg, fg: T.muted },
});

function updateStatus(msg?: string) {
  if (msg) state.statusMessage = msg;
  const k = (key: string, label: string) => `{bold}{${T.accent}-fg}${key}{/${T.accent}-fg}{/bold}{${T.muted}-fg}:${label}{/${T.muted}-fg}`;
  const keys = `${k('q', 'quit')} ${k('a', 'accts')} ${k('t', 'txns')} ${k('b', 'budget')} ${k('c', 'cats')} ${k('p', 'payees')} ${k('n', 'new')} ${k('␣', 'edit')} ${k('r', 'sync')} ${k('F2', 'switch')}`;
  statusBar.setContent(`  ${state.statusMessage}\n  ${keys}`);
}

// ── Layout ────────────────────────────────────────────────────

screen.append(header);
screen.append(sidebar);
screen.append(txnList);
screen.append(budgetList);
screen.append(mainPanel);
screen.append(statusBar);

// ── Client ────────────────────────────────────────────────────

let ActualClient: ActualClientType;
let client: InstanceType<ActualClientType>;

async function connect() {
  updateStatus(`{${T.accent}-fg}${IC.sparkle} Connecting...{/${T.accent}-fg}`);
  screen.render();

  try {
    client = ActualClient.fromEnv();
    await client.connect();
    state.connected = true;
    await refreshConnectedState();
  } catch (err: any) {
    updateStatus(`{${T.red}-fg}${IC.cross} Connection failed: ${err.message}{/${T.red}-fg}`);
    screen.render();
  }
}

async function refreshConnectedState() {
  try {
    await client.init();
    state.budgetFiles = await client.listBudgets();
  } catch {}

  const currentId = client.getConfig().budgetSyncId;
  const current = state.budgetFiles.find((b: any) => b.groupId === currentId || b.cloudFileId === currentId);
  state.budgetName = current?.name || currentId || 'Unknown';

  updateStatus(`{${T.accent}-fg}${IC.sparkle} Loading accounts...{/${T.accent}-fg}`);
  screen.render();

  state.accounts = await client.api.getAccounts();
  state.categories = await client.api.getCategoryGroups();
  buildCategoryMap();

  state.payees = await client.api.getPayees();
  state.payeeMap = {};
  for (const p of state.payees) state.payeeMap[p.id] = p.name;
  for (const a of state.accounts) state.payeeMap[a.id] = a.name;

  updateStatus(`{${T.accent}-fg}${IC.sparkle} Calculating balances...{/${T.accent}-fg}`);
  screen.render();
  state.accountBalances = {};
  for (const a of state.accounts) {
    try {
      const txns = await client.api.getTransactions(a.id);
      let bal = 0;
      for (const t of txns) { if (!t.is_child) bal += t.amount; }
      state.accountBalances[a.id] = bal;
    } catch { state.accountBalances[a.id] = 0; }
  }

  state.budgetMonths = [];
  state.budgetData = null;
  try {
    state.budgetMonths = await client.api.getBudgetMonths();
    if (state.budgetMonths.length > 0) {
      state.budgetData = await client.api.getBudgetMonth(state.budgetMonths[state.budgetMonths.length - 1]);
    }
  } catch {}

  state.loading = false;
  updateHeader();
  updateSidebar();
  updateStatus(`{${T.green}-fg}${IC.check} Ready{/${T.green}-fg} {${T.muted}-fg}— ${state.accounts.length} accounts{/${T.muted}-fg}`);

  const first = state.accounts.findIndex((a: any) => !a.offbudget && !a.closed);
  if (first >= 0) {
    state.selectedAccount = first;
    const si = sidebarAccountIndex.indexOf(first);
    if (si >= 0) sidebar.select(si);
    await loadTransactions();
  }
  sidebar.focus();
  screen.render();
}

let loadGeneration = 0;

async function loadAllTransactions() {
  const thisGen = ++loadGeneration;
  state.loadingTxns = true;
  updateStatus(`{${T.accent}-fg}${IC.sparkle} Loading all transactions...{/${T.accent}-fg}`);
  showTxnView();
  txnList.setLabel(` ${IC.star} All Accounts `);
  txnList.setItems([`  {${T.accent}-fg}${IC.sparkle} Loading...{/${T.accent}-fg}`]);
  txnListIndex = [-1];
  screen.render();

  try {
    const allTxns: any[] = [];
    for (const acct of state.accounts) {
      if (acct.closed) continue;
      try {
        const txns = await client.api.getTransactions(acct.id);
        for (const t of txns) {
          allTxns.push({ ...t, _accountName: acct.name });
        }
      } catch {}
    }

    if (thisGen !== loadGeneration) return;

    // Sort by date descending
    allTxns.sort((a: any, b: any) => b.date.localeCompare(a.date));
    state.transactions = allTxns;
    state.selectedView = 'transactions';
    updateMainPanel();
    updateStatus(`{${T.green}-fg}${IC.check}{/${T.green}-fg} ${allTxns.length} txns across all accounts`);
  } catch (err: any) {
    if (thisGen !== loadGeneration) return;
    updateStatus(`{${T.red}-fg}${IC.cross} ${err.message}{/${T.red}-fg}`);
  } finally {
    if (thisGen === loadGeneration) {
      state.loadingTxns = false;
      updateMainPanel();
      txnList.focus();
      screen.render();
    }
  }
}

async function loadTransactions() {
  const account = state.accounts[state.selectedAccount];
  if (!account) return;

  // Cancel any in-flight load by incrementing generation
  const thisGen = ++loadGeneration;
  state.loadingTxns = true;
  updateStatus(`{${T.accent}-fg}${IC.sparkle} Loading ${account.name}...{/${T.accent}-fg}`);
  updateMainPanel();
  screen.render();

  try {
    // Load ALL transactions for the account (no date filter)
    const txns = await client.api.getTransactions(account.id);

    // If user scrolled to another account while loading, discard this result
    if (thisGen !== loadGeneration) return;

    state.transactions = txns;
    state.selectedView = 'transactions';

    const bal = state.accountBalances[account.id] || 0;
    updateStatus(`{${T.green}-fg}${IC.check}{/${T.green}-fg} ${txns.length} txns {${T.muted}-fg}${IC.dot} ${account.name} ${IC.dot} bal: ${formatAmount(bal)}{/${T.muted}-fg}`);
  } catch (err: any) {
    if (thisGen !== loadGeneration) return;
    updateStatus(`{${T.red}-fg}${IC.cross} ${err.message}{/${T.red}-fg}`);
  } finally {
    if (thisGen === loadGeneration) {
      state.loadingTxns = false;
      updateMainPanel();
      screen.render();
    }
  }
}

// ── Key Bindings ──────────────────────────────────────────────

screen.key(['q', 'C-c'], async () => {
  try { if (client) await client.disconnect(); } catch {}
  process.exit(0);
});

screen.key(['a'], () => {
  state.selectedView = 'accounts'; sidebar.focus();
  updateHeader(); updateMainPanel(); screen.render();
});

screen.key(['t'], async () => {
  state.selectedView = 'transactions';
  updateHeader(); await loadTransactions();
});

screen.key(['b'], () => {
  state.selectedView = 'budget';
  updateHeader(); updateMainPanel(); screen.render();
});

screen.key(['c'], () => {
  state.selectedView = 'categories';
  updateHeader(); updateMainPanel(); screen.render();
});

screen.key(['p'], () => {
  state.selectedView = 'payees';
  updateHeader(); updateMainPanel(); screen.render();
});

screen.key(['r'], async () => {
  updateStatus(`{${T.accent}-fg}${IC.sparkle} Syncing...{/${T.accent}-fg}`);
  screen.render();
  try {
    await client.sync();
    state.accounts = await client.api.getAccounts();
    // Recompute balances
    for (const a of state.accounts) {
      try {
        const txns = await client.api.getTransactions(a.id);
        let bal = 0;
        for (const t of txns) { if (!t.is_child) bal += t.amount; }
        state.accountBalances[a.id] = bal;
      } catch {}
    }
    updateSidebar();
    if (state.selectedView === 'transactions') await loadTransactions();
    updateStatus(`{${T.green}-fg}${IC.check} Synced{/${T.green}-fg}`);
  } catch (err: any) {
    updateStatus(`{${T.red}-fg}${IC.cross} Sync failed{/${T.red}-fg}`);
  }
  screen.render();
});

screen.key(['tab'], () => {
  if (sidebar.focused) {
    if (state.selectedView === 'transactions') txnList.focus();
    else mainPanel.focus();
  } else {
    sidebar.focus();
  }
  screen.render();
});

// Helper: skip non-selectable rows in a list
function addSkipLogic(list: any, indexMap: () => Array<any>, isSelectable: (val: any) => boolean) {
  list.key(['up', 'k'], () => {
    let cur = (list as any).selected || 0;
    cur--;
    while (cur >= 0 && !isSelectable(indexMap()[cur])) cur--;
    if (cur >= 0) list.select(cur);
    screen.render();
  });
  list.key(['down', 'j'], () => {
    let cur = (list as any).selected || 0;
    const map = indexMap();
    cur++;
    while (cur < map.length && !isSelectable(map[cur])) cur++;
    if (cur < map.length) list.select(cur);
    screen.render();
  });
}

// Sidebar: skip headers (-1), allow accounts (>=0) and All Accounts (-2)
addSkipLogic(sidebar, () => sidebarAccountIndex, (val) => val !== -1);

// Transaction list: skip headers/separators (-1), allow transaction rows (>=0)
addSkipLogic(txnList, () => txnListIndex, (val) => val >= 0);

// Budget list: skip headers (null), allow category rows (non-null)
addSkipLogic(budgetList, () => budgetListIndex, (val) => val !== null);

// Sidebar: auto-load transactions on scroll with debounce
let scrollTimer: ReturnType<typeof setTimeout> | null = null;

sidebar.on('select item', (_item: any, index: number) => {
  const realIdx = sidebarAccountIndex[index];
  if (realIdx === -2) {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { loadAllTransactions(); }, 300);
    return;
  }
  if (realIdx < 0) return;
  state.selectedAccount = realIdx;

  // Auto-load with debounce (transactions show while scrolling)
  if (scrollTimer) clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => { loadTransactions(); }, 300);
});

// Enter or Right = drill into the account (focus txn list for scrolling/editing)
sidebar.key(['enter', 'right'], async () => {
  const si = (sidebar as any).selected || 0;
  const realIdx = sidebarAccountIndex[si];

  if (realIdx === -2) {
    if (scrollTimer) clearTimeout(scrollTimer);
    await loadAllTransactions();
    return;
  }
  if (realIdx < 0) return;

  state.selectedAccount = realIdx;
  if (scrollTimer) clearTimeout(scrollTimer);
  // Load if not already loaded, then focus txn list
  await loadTransactions();
  txnList.focus();
  screen.render();
});

// Esc or Left from txn list = go back to sidebar
txnList.key(['escape', 'left'], () => {
  sidebar.focus();
  screen.render();
});

// Esc or Left from info panel = go back to sidebar
mainPanel.key(['escape', 'left'], () => {
  sidebar.focus();
  screen.render();
});

// ── Transaction Entry Form (Expense / Income / Transfer) ─────

let addTxnType: 'expense' | 'income' | 'transfer' = 'expense';

const inputForm = blessed.form({
  top: 'center', left: 'center', width: 60, height: 19,
  label: ` ${IC.sparkle} New Expense `,
  border: { type: 'line', fg: T.accent },
  tags: true, keys: true, vi: false, hidden: true,
  style: {
    bg: '#1a1a2e', fg: T.fg,
    border: { fg: T.accent },
    label: { fg: T.accent, bold: true },
  },
});

// Type selector label + help
const typeLabel = blessed.text({
  parent: inputForm, top: 1, left: 2, tags: true, content: '', style: { bg: '#1a1a2e' },
});
blessed.text({
  parent: inputForm, top: 2, left: 2, tags: true,
  content: `{${T.dim}-fg} Ctrl+T: cycle type  │  Ctrl+1: expense  Ctrl+2: income  Ctrl+3: transfer{/${T.dim}-fg}`,
  style: { bg: '#1a1a2e' },
});

function updateTypeLabel() {
  const defs = [
    { key: 'expense',  num: '1', icon: '💸', color: T.red, label: 'EXPENSE' },
    { key: 'income',   num: '2', icon: '💰', color: T.green, label: 'INCOME' },
    { key: 'transfer', num: '3', icon: '↔️',  color: T.blue, label: 'TRANSFER' },
  ];
  const labels = defs.map(d => {
    if (d.key === addTxnType) {
      return `{${d.color}-fg}{bold} ${d.icon} ${d.label} {/bold}{/${d.color}-fg}`;
    }
    return `{${T.dim}-fg} ${d.icon} ${d.key} {/${T.dim}-fg}`;
  });
  typeLabel.setContent(` ${labels.join(`{${T.dim}-fg}│{/${T.dim}-fg}`)}  {${T.muted}-fg}C-t:switch{/${T.muted}-fg}`);
}

const formFields: Record<string, any> = {};
const formLabels: Record<string, any> = {};
const allFieldDefs = [
  { label: 'Date',       key: 'date',     top: 4 },
  { label: 'Amount',     key: 'amount',   top: 6 },
  { label: 'Payee',      key: 'payee',    top: 8 },
  { label: 'Category',   key: 'category', top: 10 },
  { label: 'Notes',      key: 'notes',    top: 12 },
  { label: 'To Account', key: 'toAcct',   top: 10 },
];

for (const fd of allFieldDefs) {
  formLabels[fd.key] = blessed.text({
    parent: inputForm, top: fd.top, left: 2, tags: true,
    content: `{${T.muted}-fg}${fd.label}:{/${T.muted}-fg}`, style: { bg: '#1a1a2e' },
  });
  formFields[fd.key] = blessed.textbox({
    parent: inputForm, top: fd.top, left: 16, width: 38, height: 1,
    inputOnFocus: true, value: '',
    style: { fg: '#fff', bg: '#2d3436', focus: { bg: T.accent, fg: '#fff' } },
  });
}
formLabels['toAcct'].hide(); formFields['toAcct'].hide();

function showFieldsForType() {
  updateTypeLabel();
  if (addTxnType === 'transfer') {
    formLabels['category'].hide(); formFields['category'].hide();
    formLabels['payee'].hide(); formFields['payee'].hide();
    formLabels['toAcct'].show(); formFields['toAcct'].show();
  } else {
    formLabels['category'].show(); formFields['category'].show();
    formLabels['payee'].show(); formFields['payee'].show();
    formLabels['toAcct'].hide(); formFields['toAcct'].hide();
  }
  screen.render();
}

blessed.text({
  parent: inputForm, top: 15, left: 2, tags: true,
  content: `{${T.green}-fg}Tab{/${T.green}-fg}:next field  {${T.accent}-fg}C-s{/${T.accent}-fg}:save  {${T.red}-fg}Esc{/${T.red}-fg}:cancel`,
  style: { bg: '#1a1a2e' },
});

screen.append(inputForm);

function getFieldOrder(): string[] {
  return addTxnType === 'transfer'
    ? ['date', 'amount', 'toAcct', 'notes']
    : ['date', 'amount', 'payee', 'category', 'notes'];
}

let currentField = 0;
function focusField(idx: number) {
  const order = getFieldOrder();
  currentField = idx % order.length;
  formFields[order[currentField]].focus();
}

for (const key of Object.keys(formFields)) {
  formFields[key].key(['enter', 'tab'], () => {
    const order = getFieldOrder();
    const idx = order.indexOf(key);
    if (idx >= 0) focusField(idx + 1);
  });
  formFields[key].key(['escape'], () => { inputForm.hide(); txnList.focus(); screen.render(); });
  formFields[key].key(['C-t'], () => {
    const types: Array<'expense' | 'income' | 'transfer'> = ['expense', 'income', 'transfer'];
    addTxnType = types[(types.indexOf(addTxnType) + 1) % types.length];
    showFieldsForType();
    inputForm.setLabel(` ${IC.sparkle} New ${addTxnType.charAt(0).toUpperCase() + addTxnType.slice(1)} `);
  });
  formFields[key].key(['C-1'], () => { addTxnType = 'expense'; showFieldsForType(); inputForm.setLabel(` ${IC.sparkle} New Expense `); });
  formFields[key].key(['C-2'], () => { addTxnType = 'income'; showFieldsForType(); inputForm.setLabel(` ${IC.sparkle} New Income `); });
  formFields[key].key(['C-3'], () => { addTxnType = 'transfer'; showFieldsForType(); inputForm.setLabel(` ${IC.sparkle} New Transfer `); });
  formFields[key].key(['C-s'], async () => {
    const account = state.accounts[state.selectedAccount];
    if (!account) return;
    const date = formFields.date.getValue();
    const amount = parseFloat(formFields.amount.getValue() || '0');
    const payeeName = formFields.payee.getValue();
    const notes = formFields.notes.getValue();
    if (!date || isNaN(amount)) { updateStatus(`{${T.red}-fg}Invalid date/amount{/${T.red}-fg}`); screen.render(); return; }
    inputForm.hide();
    updateStatus(`{${T.accent}-fg}${IC.sparkle} Adding ${addTxnType}...{/${T.accent}-fg}`);
    screen.render();
    try {
      if (addTxnType === 'transfer') {
        // Transfer: hide payee, use To Account
        const toName = formFields.toAcct.getValue();
        if (!toName) throw new Error('To Account required');
        const toAcct = state.accounts.find((a: any) => a.name.toLowerCase().includes(toName.toLowerCase()));
        if (!toAcct) throw new Error(`Account not found: ${toName}`);
        const xferPayee = state.payees.find((p: any) => p.transfer_acct === toAcct.id);
        if (!xferPayee) throw new Error(`No transfer payee for ${toAcct.name}`);
        await client.api.addTransactions(account.id, [{
          date, amount: -Math.abs(Math.round(amount * 100)), // transfers always debit from source
          payee: xferPayee.id, notes: notes || undefined, cleared: true,
        }]);
      } else {
        // Expense or Income
        const catName = formFields.category.getValue();
        let catId: string | undefined;
        if (catName) {
          const cat = Object.entries(categoryMap).find(([_, n]) => n.toLowerCase().includes(catName.toLowerCase()));
          if (cat) catId = cat[0];
        }
        // Expense = negative amount, Income = positive (user enters positive number)
        const amtCents = Math.round(Math.abs(amount) * 100);
        const signedAmt = addTxnType === 'expense' ? -amtCents : amtCents;
        await client.api.addTransactions(account.id, [{
          date, amount: signedAmt,
          payee_name: payeeName || undefined, category: catId,
          notes: notes || undefined, cleared: true,
        }]);
      }
      await client.api.sync();
      updateStatus(`{${T.green}-fg}${IC.check} ${addTxnType} added{/${T.green}-fg}`);
      await loadTransactions();
    } catch (err: any) {
      updateStatus(`{${T.red}-fg}${IC.cross} ${err.message}{/${T.red}-fg}`);
    }
    txnList.focus(); screen.render();
  });
}

// ── Edit Transaction Form ─────────────────────────────────────

const editForm = blessed.form({
  top: 'center', left: 'center', width: 60, height: 18,
  label: ` ${IC.sparkle} Edit Transaction `,
  border: { type: 'line', fg: T.yellow },
  tags: true, keys: true, vi: false, hidden: true,
  style: {
    bg: '#1a1a2e', fg: T.fg,
    border: { fg: T.yellow },
    label: { fg: T.yellow, bold: true },
  },
});

// Type indicator for edit (read-only display)
const editTypeLabel = blessed.text({
  parent: editForm, top: 1, left: 2, tags: true, content: '', style: { bg: '#1a1a2e' },
});

const editFields: Record<string, any> = {};
const editLabels: Record<string, any> = {};
const editFieldDefs = [
  { label: 'Date',       key: 'date',     top: 3 },
  { label: 'Amount',     key: 'amount',   top: 5 },
  { label: 'Payee',      key: 'payee',    top: 7 },
  { label: 'Category',   key: 'category', top: 9 },
  { label: 'Notes',      key: 'notes',    top: 11 },
];

for (const fd of editFieldDefs) {
  editLabels[fd.key] = blessed.text({
    parent: editForm, top: fd.top, left: 2, tags: true,
    content: `{${T.muted}-fg}${fd.label}:{/${T.muted}-fg}`, style: { bg: '#1a1a2e' },
  });
  editFields[fd.key] = blessed.textbox({
    parent: editForm, top: fd.top, left: 16, width: 38, height: 1,
    inputOnFocus: true, value: '',
    style: { fg: '#fff', bg: '#2d3436', focus: { bg: T.yellow, fg: '#000' } },
  });
}

blessed.text({
  parent: editForm, top: 14, left: 2, tags: true,
  content: `{${T.green}-fg}Tab{/${T.green}-fg}:next  {${T.yellow}-fg}C-s{/${T.yellow}-fg}:save  {${T.red}-fg}Esc{/${T.red}-fg}:cancel  {${T.red}-fg}C-d{/${T.red}-fg}:delete`,
  style: { bg: '#1a1a2e' },
});

screen.append(editForm);

let editingTxnId: string | null = null;
const editOrder = ['date', 'amount', 'payee', 'category', 'notes'];

function focusEditField(idx: number) { editFields[editOrder[idx % editOrder.length]].focus(); }

for (const key of editOrder) {
  editFields[key].key(['enter', 'tab'], () => focusEditField((editOrder.indexOf(key) + 1) % editOrder.length));
  editFields[key].key(['escape'], () => { editForm.hide(); txnList.focus(); screen.render(); });
  editFields[key].key(['C-d'], async () => {
    if (!editingTxnId) return;
    editForm.hide();
    updateStatus(`{${T.red}-fg}Deleting...{/${T.red}-fg}`);
    screen.render();
    try {
      await client.api.deleteTransaction(editingTxnId);
      await client.api.sync();
      updateStatus(`{${T.green}-fg}${IC.check} Deleted{/${T.green}-fg}`);
      await loadTransactions();
    } catch (err: any) {
      updateStatus(`{${T.red}-fg}${IC.cross} ${err.message}{/${T.red}-fg}`);
    }
    txnList.focus(); screen.render();
  });
  editFields[key].key(['C-s'], async () => {
    if (!editingTxnId) return;
    editForm.hide();
    updateStatus(`{${T.accent}-fg}${IC.sparkle} Saving...{/${T.accent}-fg}`);
    screen.render();
    try {
      const fields: any = {};
      const newDate = editFields.date.getValue();
      const newAmt = editFields.amount.getValue();
      const newNotes = editFields.notes.getValue();

      if (newDate) fields.date = newDate;
      if (newAmt && !isNaN(parseFloat(newAmt))) fields.amount = Math.round(parseFloat(newAmt) * 100);
      if (newNotes !== undefined) fields.notes = newNotes;

      // Resolve category name to ID
      const catInput = editFields.category.getValue()?.trim();
      if (catInput) {
        const catLower = catInput.toLowerCase();
        const catId = Object.entries(categoryMap).find(([_, name]) => name.toLowerCase() === catLower || name.toLowerCase().includes(catLower));
        if (catId) fields.category = catId[0];
      }

      // Resolve payee name
      const payeeInput = editFields.payee.getValue()?.trim();
      if (payeeInput) {
        const existingPayee = state.payees.find((p: any) => p.name.toLowerCase() === payeeInput.toLowerCase());
        if (existingPayee) {
          fields.payee = existingPayee.id;
        } else {
          // Create new payee
          const newPayee = await client.api.createPayee({ name: payeeInput });
          fields.payee = newPayee;
        }
      }

      await client.api.updateTransaction(editingTxnId, fields);
      await client.api.sync();
      updateStatus(`{${T.green}-fg}${IC.check} Updated{/${T.green}-fg}`);
      await loadTransactions();
    } catch (err: any) {
      updateStatus(`{${T.red}-fg}${IC.cross} ${err.message}{/${T.red}-fg}`);
    }
    txnList.focus(); screen.render();
  });
}

// Press Space on a selected transaction row to edit
txnList.key(['space'], () => {
  const sel = (txnList as any).selected || 0;
  const txnIdx = txnListIndex[sel];
  if (txnIdx < 0) return;

  const t = state.transactions[txnIdx];
  if (!t) return;

  editingTxnId = t.id;

  // Detect type
  const isTransfer = !!t.transfer_id;
  const isSplit = !!t.is_parent;
  const isIncome = !isTransfer && (t.amount || 0) > 0;
  const isExpense = !isTransfer && (t.amount || 0) <= 0;
  const typeDefs = [
    { key: 'expense',  icon: '💸', color: T.red,    active: isExpense },
    { key: 'income',   icon: '💰', color: T.green,  active: isIncome },
    { key: 'transfer', icon: '↔️',  color: T.blue,   active: isTransfer },
  ];
  const typeLabelsArr = typeDefs.map(d =>
    d.active
      ? `{${d.color}-fg}{bold} ${d.icon} ${d.key.toUpperCase()} {/bold}{/${d.color}-fg}`
      : `{${T.dim}-fg} ${d.icon} ${d.key} {/${T.dim}-fg}`
  );
  const splitTag = isSplit ? `  {${T.purple}-fg}✂️ SPLIT{/${T.purple}-fg}` : '';
  editTypeLabel.setContent(` ${typeLabelsArr.join(`{${T.dim}-fg}│{/${T.dim}-fg}`)}${splitTag}  {${T.dim}-fg}${t.id.slice(0, 8)}{/${T.dim}-fg}`);

  // Pre-fill
  editFields.date.setValue(t.date || '');
  editFields.amount.setValue(((t.amount || 0) / 100).toString());

  let payee = t.payee_name || t.imported_payee || '';
  if (!payee && t.payee) payee = state.payeeMap[t.payee] || '';
  editFields.payee.setValue(payee);

  if (isTransfer) {
    // Show destination account as category
    const destPayee = t.payee ? state.payeeMap[t.payee] : '';
    editFields.category.setValue(destPayee ? `→ ${destPayee}` : '→ transfer');
    editLabels.category.setContent(`{${T.blue}-fg}Transfer to:{/${T.blue}-fg}`);
  } else {
    editFields.category.setValue(t.category ? (categoryMap[t.category] || '') : '');
    editLabels.category.setContent(`{${T.muted}-fg}Category:{/${T.muted}-fg}`);
  }

  let notes = '';
  if (t.notes) {
    const b = t.notes.indexOf('•');
    if (b > 0) notes = t.notes.slice(b + 1).trim();
    // Strip generic "XXX (FX rate: N)" FX-rule prefixes without a • separator.
    else if (!/\b[A-Z]{3}\s*\(FX rate:/.test(t.notes)) notes = t.notes;
  }
  editFields.notes.setValue(notes);

  const editTitle = isTransfer ? '↔️ Edit Transfer' : isIncome ? '💰 Edit Income' : '💸 Edit Expense';
  editForm.setLabel(` ${editTitle}${isSplit ? ' (Split)' : ''} `);
  editForm.show();
  focusEditField(0);
  screen.render();
});

// Tab from sidebar focuses txnList, tab from txnList focuses sidebar
txnList.key(['tab'], () => { sidebar.focus(); screen.render(); });

screen.key(['n'], () => {
  if (!state.connected) return;
  addTxnType = 'expense';
  formFields.date.setValue(new Date().toISOString().slice(0, 10));
  formFields.amount.setValue('');
  formFields.payee.setValue('');
  formFields.category.setValue('');
  formFields.notes.setValue('');
  formFields.toAcct.setValue('');
  showFieldsForType();
  inputForm.setLabel(` 💸 New Expense `);
  inputForm.show(); focusField(0); screen.render();
});

// Quick keys for specific types
screen.key(['C-e'], () => { if (!state.connected) return; addTxnType = 'expense'; screen.emit('keypress', null, {name: 'n'}); });
screen.key(['C-i'], () => { if (!state.connected) return; addTxnType = 'income'; screen.emit('keypress', null, {name: 'n'}); });

// ── Budget Edit Popup ─────────────────────────────────────────

const budgetEditForm = blessed.form({
  top: 'center', left: 'center', width: 45, height: 10,
  label: ` ${IC.sparkle} Set Budget `,
  border: { type: 'line', fg: T.accent2 },
  tags: true, keys: true, vi: false, hidden: true,
  style: { bg: '#1a1a2e', fg: T.fg, border: { fg: T.accent2 }, label: { fg: T.accent2, bold: true } },
});

const budgetEditCatLabel = blessed.text({
  parent: budgetEditForm, top: 1, left: 2, tags: true, content: '', style: { bg: '#1a1a2e' },
});

blessed.text({
  parent: budgetEditForm, top: 3, left: 2, tags: true,
  content: `{${T.muted}-fg}Amount:{/${T.muted}-fg}`, style: { bg: '#1a1a2e' },
});

const budgetEditInput = blessed.textbox({
  parent: budgetEditForm, top: 3, left: 12, width: 26, height: 1,
  inputOnFocus: true, value: '',
  style: { fg: '#fff', bg: '#2d3436', focus: { bg: T.accent2, fg: '#000' } },
});

blessed.text({
  parent: budgetEditForm, top: 6, left: 2, tags: true,
  content: `{${T.green}-fg}Enter{/${T.green}-fg}:save  {${T.red}-fg}Esc{/${T.red}-fg}:cancel`,
  style: { bg: '#1a1a2e' },
});

screen.append(budgetEditForm);

let editingBudgetCat: { categoryId: string; name: string } | null = null;

budgetEditInput.key(['enter'], async () => {
  if (!editingBudgetCat) return;
  const val = budgetEditInput.getValue();
  const amount = parseFloat(val || '0');
  if (isNaN(amount)) { updateStatus(`{${T.red}-fg}Invalid amount{/${T.red}-fg}`); screen.render(); return; }

  budgetEditForm.hide();
  updateStatus(`{${T.accent}-fg}${IC.sparkle} Setting budget...{/${T.accent}-fg}`);
  screen.render();

  try {
    const month = state.budgetMonths[state.budgetMonths.length - 1];
    await client.api.setBudgetAmount(month, editingBudgetCat.categoryId, Math.round(amount * 100));
    await client.api.sync();
    // Refresh budget data
    state.budgetData = await client.api.getBudgetMonth(month);
    renderBudget();
    updateStatus(`{${T.green}-fg}${IC.check} Budget set: ${editingBudgetCat.name} = ${formatAmount(Math.round(amount * 100))}{/${T.green}-fg}`);
  } catch (err: any) {
    updateStatus(`{${T.red}-fg}${IC.cross} ${err.message}{/${T.red}-fg}`);
  }
  budgetList.focus(); screen.render();
});

budgetEditInput.key(['escape'], () => {
  budgetEditForm.hide(); budgetList.focus(); screen.render();
});

// Space on budget list = edit that category's budget
budgetList.key(['space'], () => {
  const sel = (budgetList as any).selected || 0;
  const entry = budgetListIndex[sel];
  if (!entry) return;

  editingBudgetCat = entry;
  budgetEditCatLabel.setContent(` {bold}{${T.accent2}-fg}${entry.name}{/${T.accent2}-fg}{/bold}`);

  // Pre-fill with current budgeted amount
  const budget = state.budgetData;
  let currentAmount = 0;
  for (const g of (budget as any)?.categoryGroups || []) {
    for (const c of g.categories || []) {
      if (c.id === entry.categoryId) { currentAmount = (c.budgeted || 0) / 100; break; }
    }
  }
  budgetEditInput.setValue(currentAmount.toString());
  budgetEditForm.show();
  budgetEditInput.focus();
  screen.render();
});

// Navigation for budget list
budgetList.key(['escape', 'left'], () => { sidebar.focus(); screen.render(); });

// ── Budget File Switcher ──────────────────────────────────────

const budgetSwitcher = blessed.list({
  top: 'center', left: 'center', width: 50, height: 12,
  label: ` ${IC.sparkle} Switch Budget `,
  border: { type: 'line', fg: T.accent },
  tags: true, keys: true, vi: true, mouse: true, hidden: true,
  style: {
    bg: '#1a1a2e', fg: T.fg,
    border: { fg: T.accent },
    label: { fg: T.accent, bold: true },
    selected: { bg: T.accent, fg: '#ffffff', bold: true },
    item: { fg: T.fg },
  },
});

screen.append(budgetSwitcher);

const budgetPasswordPrompt = blessed.prompt({
  parent: screen,
  border: { type: 'line', fg: T.borderHi },
  height: 9,
  width: '60%',
  top: 'center',
  left: 'center',
  label: ' Budget Password ',
  tags: true,
  keys: true,
  vi: true,
  style: {
    bg: T.panelBg,
    fg: T.fg,
    border: { fg: T.borderHi },
    label: { fg: T.accent2, bold: true },
  },
});

function promptForBudgetPassword(name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    budgetPasswordPrompt.input(`Password for "${name}":`, '', (error: unknown, value: string) => {
      sidebar.focus();
      screen.render();
      if (error) {
        reject(error);
        return;
      }

      const password = String(value || '').trim();
      if (!password) {
        reject(new Error(`Password required for encrypted budget "${name}".`));
        return;
      }

      resolve(password);
    });
  });
}

// Deduplicated budget list (server may return cloudFileId + groupId duplicates)
function getUniqueBudgets(): any[] {
  const seen = new Set<string>();
  return state.budgetFiles.filter((b: any) => {
    if (seen.has(b.name)) return false;
    seen.add(b.name);
    return true;
  });
}

screen.key(['S', 'S-s', 'f2'], () => {
  if (!state.connected || state.budgetFiles.length === 0) return;
  const unique = getUniqueBudgets();
  const items = unique.map((b: any) => {
    const current = b.name === state.budgetName ? `{${T.green}-fg}${IC.check}{/${T.green}-fg}` : ' ';
    const enc = b.encryptKeyId ? ` {${T.yellow}-fg}${IC.lock}{/${T.yellow}-fg}` : '';
    return `  ${current} ${b.name}${enc}`;
  });
  items.push('');
  items.push(`  {${T.muted}-fg}Enter: switch  Esc: cancel{/${T.muted}-fg}`);
  budgetSwitcher.setItems(items);
  budgetSwitcher.show();
  budgetSwitcher.focus();
  screen.render();
});

budgetSwitcher.key(['escape'], () => {
  budgetSwitcher.hide(); sidebar.focus(); screen.render();
});

budgetSwitcher.key(['enter'], async () => {
  const sel = (budgetSwitcher as any).selected || 0;
  const unique = getUniqueBudgets();
  if (sel >= unique.length) { budgetSwitcher.hide(); sidebar.focus(); screen.render(); return; }

  const target = unique[sel];
  budgetSwitcher.hide();
  updateStatus(`{${T.accent}-fg}${IC.sparkle} Switching to ${target.name}...{/${T.accent}-fg}`);
  screen.render();

  try {
    state.accounts = [];
    state.transactions = [];
    state.payees = [];
    state.accountBalances = {};
    state.budgetData = null;
    state.connected = false;

    await client.switchBudget({
      budgetRef: target.groupId || target.cloudFileId,
      isInteractive: true,
      promptForPassword: async (context) => promptForBudgetPassword(context.name),
    });
    state.connected = true;
    await refreshConnectedState();
  } catch (err: any) {
    updateStatus(`{${T.red}-fg}${IC.cross} Switch failed: ${err.message}{/${T.red}-fg}`);
    screen.render();
  }
});

// ── Start ─────────────────────────────────────────────────────

({ ActualClient } = await import('../client.js'));

sidebar.focus();
updateHeader();
updateStatus(`{${T.accent}-fg}${IC.sparkle} Starting arc...{/${T.accent}-fg}`);
screen.render();
connect();
