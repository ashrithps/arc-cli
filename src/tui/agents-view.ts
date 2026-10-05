/**
 * The TUI's Agents view: what is waiting on you, who is working, and what
 * they did, live.
 *
 * Self-contained so app.ts only has to open and close it: it owns its widgets,
 * its polling and its keys, and everything it touches on the network comes in
 * through `deps`, which is also what lets the tests drive it headless.
 *
 *   ┌ Waiting on you ─────────────────────────────────────────────┐
 *   │ ◆ DEL Codex wants to delete a category            9m left   │
 *   ├ Agents ────────┬ Timeline ──────────────────────────────────┤
 *   │ ● Claude Code  │  TODAY · MON 5 OCT                          │
 *   │ ○ Cursor       │  ├── Claude Code · ashrith-mbp · 6 actions  │
 *   └────────────────┴─────────────────────────────────────────────┘
 */
import blessed from 'blessed';
import type { AgentApi } from '../agent-controls/api.js';
import type { AuditHeadWire, AuditRowWire, PendingRequestSummaryWire } from '../agent-controls/wire.js';
import { verifyChain, type ChainVerdict } from '../agent-controls/chain.js';
import { clientName, summaryPhrase, type ActivityJournal, type MachineInfo } from '../agent-controls/interpret.js';
import { renderActivity, span } from '../agent-controls/render-timeline.js';

export type AgentsViewApi = Pick<AgentApi, 'activity' | 'listPending' | 'deny'>;

/** Approves a request with this Mac's Secure Enclave key (challenge → Touch ID → mac-decide). */
export interface AgentsViewMacApprover {
  available?(): boolean | Promise<boolean>;
  approve(requestId: string): Promise<unknown>;
}

export interface AgentsViewDeps {
  api: AgentsViewApi;
  journal?: ActivityJournal;
  macApprover?: AgentsViewMacApprover;
  onClose(): void;
  connections?: Record<string, MachineInfo>;
  pollMs?: number;
  now?: () => number;
  tz?: string;
}

export interface AgentsView {
  show(): void;
  hide(): void;
  destroy(): void;
  /** One poll, now. Resolves when the view has re-rendered. */
  refresh(): Promise<void>;
}

const T = {
  bg: '#0c0c14',
  panelBg: '#0f0f1a',
  headerBg: '#13132a',
  fg: '#e0e0e8',
  border: '#2a2a3a',
  borderHi: '#6c5ce7',
  accent: '#a78bfa',
  muted: '#6b7280',
  dim: '#374151',
  green: '#34d399',
  brass: '#C9A44C',
  vermilion: '#E5533D',
};

const LIVE_MS = 2 * 60 * 1000;
const PAGE = 500;
/** Rows drawn in the timeline. All rows are kept, so the chain is verified from its anchor. */
const SHOWN = 2000;

interface AgentRow { key: string; client: string; connectionId?: string; lastAt: number; today: number }

const fg = (hex: string, s: string) => `{${hex}-fg}${s}{/${hex}-fg}`;
const esc = (s: string) => s.replace(/[{}]/g, (c) => (c === '{' ? '{open}' : '{close}'));

export function createAgentsView(screen: any, deps: AgentsViewDeps): AgentsView {
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 3000;

  let entries: AuditRowWire[] = [];
  let head: AuditHeadWire | undefined;
  let verdict: ChainVerdict | undefined;
  let pending: PendingRequestSummaryWire[] = [];
  let agents: AgentRow[] = [];
  let selectedAgent: string | null = null; // null = everyone
  let reviewing: PendingRequestSummaryWire | null = null;
  let visible = false;
  let destroyed = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let pulseTimer: ReturnType<typeof setInterval> | undefined;
  let pulse = false;
  let inFlight: Promise<void> | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let flashText = '';
  let error = '';
  let macReady = false;
  let followBottom = true;

  // ── Widgets ───────────────────────────────────────────────

  const root = blessed.box({
    parent: screen, top: 0, left: 0, width: '100%', height: '100%',
    hidden: true, tags: true, style: { bg: T.bg, fg: T.fg },
  });

  const header = blessed.box({
    parent: root, top: 0, left: 0, width: '100%', height: 1, tags: true,
    style: { bg: T.headerBg, fg: T.fg },
  });

  const pendingList = blessed.list({
    parent: root, top: 1, left: 0, width: '100%', height: 3,
    label: ' Waiting on you ', tags: true, keys: true, vi: true, mouse: true,
    border: { type: 'line' },
    style: {
      bg: T.panelBg, fg: T.fg, border: { fg: T.border }, label: { fg: T.brass, bold: true },
      selected: { bg: '#2a2410', fg: '#ffffff', bold: true }, item: { fg: T.fg },
      focus: { border: { fg: T.brass } },
    },
  });

  const agentList = blessed.list({
    parent: root, top: 4, left: 0, width: '28%', height: '100%-5',
    label: ' Agents ', tags: true, keys: true, vi: true, mouse: true,
    border: { type: 'line' },
    style: {
      bg: T.panelBg, fg: T.fg, border: { fg: T.border }, label: { fg: T.accent, bold: true },
      selected: { bg: T.borderHi, fg: '#ffffff', bold: true }, item: { fg: T.fg },
      focus: { border: { fg: T.borderHi } },
    },
  });

  const timeline = blessed.box({
    parent: root, top: 4, left: '28%', width: '72%', height: '100%-5',
    label: ' Timeline ', tags: true, keys: true, vi: true, mouse: true,
    scrollable: true, alwaysScroll: true,
    border: { type: 'line' },
    scrollbar: { ch: '│', style: { fg: T.dim } },
    style: {
      bg: T.panelBg, fg: T.fg, border: { fg: T.border }, label: { fg: T.accent, bold: true },
      focus: { border: { fg: T.borderHi } },
    },
  });

  const footer = blessed.box({
    parent: root, bottom: 0, left: 0, width: '100%', height: 1, tags: true,
    style: { bg: T.headerBg, fg: T.muted },
  });

  const review = blessed.box({
    parent: root, top: 'center', left: 'center', width: '70%', height: 13,
    label: ' Review ', tags: true, hidden: true,
    border: { type: 'line' },
    style: { bg: T.headerBg, fg: T.fg, border: { fg: T.brass }, label: { fg: T.brass, bold: true } },
  });

  const focusOrder = [pendingList, agentList, timeline];

  // ── Rendering ─────────────────────────────────────────────

  function rebuildAgents() {
    const t = now();
    const today = new Date(t);
    today.setHours(0, 0, 0, 0);
    const map = new Map<string, AgentRow>();
    for (const e of entries) {
      if (!e.client || e.client === '*' || e.source === 'phone') continue;
      const key = `${e.connectionId ?? ''}|${e.client}`;
      const a = map.get(key) ?? { key, client: e.client, connectionId: e.connectionId, lastAt: 0, today: 0 };
      a.lastAt = Math.max(a.lastAt, e.at);
      if (e.at >= today.getTime() && e.kind !== 'op.completed') a.today++;
      map.set(key, a);
    }
    agents = [...map.values()].sort((a, b) => b.lastAt - a.lastAt);
  }

  function machineOf(a: AgentRow): string {
    const m = a.connectionId ? deps.connections?.[a.connectionId] : undefined;
    if (m?.label || m?.hostname) return (m.label || m.hostname)!;
    const row = entries.find((e) => e.connectionId === a.connectionId && e.client === a.client);
    return (row && deps.journal?.lookup(row)?.hostname) || '';
  }

  function renderAgents() {
    const t = now();
    const items = [`{bold}${fg(T.accent, ' ◆ Everyone')}{/bold}  ${fg(T.muted, `${entries.length} events`)}`];
    for (const a of agents) {
      const live = t - a.lastAt < LIVE_MS;
      const dot = live ? fg(pulse ? T.green : '#1f7a59', '●') : fg(T.dim, '○');
      const seen = live ? fg(T.green, 'now') : fg(T.muted, span(t - a.lastAt));
      const machine = machineOf(a);
      items.push(` ${dot} ${esc(clientName(a.client))}  ${seen}`);
      items.push(`   ${fg(T.muted, esc([machine, a.today ? `${a.today} today` : ''].filter(Boolean).join(' · ')))}`);
    }
    const sel = (agentList as any).selected ?? 0;
    agentList.setItems(items);
    agentList.select(Math.min(sel, items.length - 1));
  }

  /** List index → agent key (two lines per agent after "Everyone"). */
  function agentAt(index: number): string | null {
    if (index <= 0) return null;
    return agents[Math.floor((index - 1) / 2)]?.key ?? null;
  }

  function renderPendingStrip() {
    const t = now();
    const rows = pending.length
      ? pending.map((r) => {
          const left = r.expiresAt - t;
          const risk = r.risk === 'destructive' ? fg(T.vermilion, 'DEL') : r.risk === 'write' ? fg(T.muted, 'W  ') : '   ';
          const right = left > 0 ? fg(T.brass, `${span(left)} left`) : fg(T.muted, 'expired');
          return ` ${fg(T.brass, '◆')} ${risk} {bold}${esc(`${clientName(r.client)} wants to ${summaryPhrase(r.summaryEnum, r.opId)}`)}{/bold}  ${right}`;
        })
      : [` ${fg(T.green, '✓')} ${fg(T.muted, 'Nothing is waiting on you')}`];
    const sel = (pendingList as any).selected ?? 0;
    pendingList.setItems(rows);
    pendingList.select(Math.min(sel, rows.length - 1));
    const h = Math.min(6, rows.length) + 2;
    pendingList.height = h;
    agentList.top = 1 + h;
    timeline.top = 1 + h;
    agentList.height = `100%-${h + 2}`;
    timeline.height = `100%-${h + 2}`;
    pendingList.setLabel(pending.length ? ` Waiting on you · ${pending.length} ` : ' Waiting on you ');
  }

  function renderTimeline() {
    const shown = (selectedAgent
      ? entries.filter((e) => `${e.connectionId ?? ''}|${e.client}` === selectedAgent)
      : entries).slice(-SHOWN);
    const width = Math.max(60, ((timeline as any).width as number) - 3);
    const text = renderActivity(shown, deps.journal, {
      width, color: true, markup: 'blessed', now: now(), tz: deps.tz, verdict, connections: deps.connections,
    });
    const atBottom = followBottom || (timeline as any).getScrollPerc() >= 99;
    timeline.setContent(text);
    if (atBottom) timeline.setScrollPerc(100);
    const label = selectedAgent ? agents.find((a) => a.key === selectedAgent) : undefined;
    timeline.setLabel(label ? ` Timeline · ${clientName(label.client)} ` : ' Timeline ');
    followBottom = false;
  }

  function renderHeader() {
    const live = agents.some((a) => now() - a.lastAt < LIVE_MS);
    const chain = !verdict
      ? fg(T.muted, 'chain …')
      : verdict.ok
        ? fg(T.green, `✓ chain verified through #${verdict.verifiedThrough}`)
        : `{bold}${fg(T.vermilion, `✗ CHAIN BROKEN AT #${verdict.breakAt}`)}{/bold}`;
    const status = error ? fg(T.vermilion, esc(error)) : live ? fg(T.green, '● live') : fg(T.muted, '○ quiet');
    header.setContent(` {bold}${fg(T.accent, '◆ Agents')}{/bold}   ${status}   ${chain}`);
  }

  function renderFooter() {
    const keys = [
      ['enter', 'review'],
      ...(macReady ? [['t', 'Touch ID approve']] : []),
      ['d', 'deny'],
      ['tab', 'focus'],
      ['r', 'refresh'],
      ['esc', 'close'],
    ];
    const hint = keys.map(([k, v]) => `${fg(T.accent, `[${k}]`)} ${v}`).join('  ');
    footer.setContent(flashText ? ` ${flashText}` : ` ${hint}`);
  }

  function renderReview() {
    if (!reviewing) return;
    const r = reviewing;
    const t = now();
    const left = r.expiresAt - t;
    const lines = [
      '',
      `  {bold}${esc(`${clientName(r.client)} wants to ${summaryPhrase(r.summaryEnum, r.opId)}`)}{/bold}`,
      '',
      `  ${fg(T.muted, 'Operation')}  ${esc(r.opId)}`,
      `  ${fg(T.muted, 'Risk     ')}  ${r.risk === 'destructive' ? fg(T.vermilion, 'destructive') : esc(r.risk)}`,
      `  ${fg(T.muted, 'Request  ')}  ${esc(r.id)}`,
      `  ${fg(T.muted, 'Expires  ')}  ${left > 0 ? fg(T.brass, `in ${span(left)}`) : fg(T.muted, 'expired')}`,
      '',
      macReady
        ? `  ${fg(T.accent, '[t]')} approve with Touch ID   ${fg(T.accent, '[d]')} deny   ${fg(T.accent, '[esc]')} back`
        : `  ${fg(T.muted, 'Approve on your phone.')}   ${fg(T.accent, '[d]')} deny   ${fg(T.accent, '[esc]')} back`,
    ];
    review.setContent(lines.join('\n'));
  }

  function renderAll() {
    if (destroyed) return;
    renderHeader();
    renderPendingStrip();
    renderAgents();
    renderTimeline();
    renderFooter();
    renderReview();
    if (visible) screen.render();
  }

  function flash(text: string) {
    flashText = text;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashText = '';
      renderFooter();
      if (visible && !destroyed) screen.render();
    }, 3000);
    renderFooter();
    if (visible) screen.render();
  }

  // ── Data ──────────────────────────────────────────────────

  async function poll() {
    try {
      for (;;) {
        const last = entries.length ? entries[entries.length - 1].seq : 0;
        const page = await deps.api.activity({ afterSeq: last, limit: PAGE });
        head = page.head;
        const fresh = page.entries.filter((e) => e.seq > last).sort((a, b) => a.seq - b.seq);
        if (fresh.length) entries = [...entries, ...fresh];
        if (page.entries.length < PAGE || !fresh.length) break;
      }
      verdict = verifyChain(entries, head);
      pending = (await deps.api.listPending()).requests;
      if (reviewing && !pending.some((p) => p.id === reviewing!.id)) closeReview();
      error = '';
    } catch (err: any) {
      error = `offline · ${err?.message ?? err}`;
    }
    rebuildAgents();
    renderAll();
  }

  function refresh(): Promise<void> {
    if (!inFlight) inFlight = poll().finally(() => { inFlight = null; });
    return inFlight;
  }

  // ── Actions ───────────────────────────────────────────────

  function selectedPending(): PendingRequestSummaryWire | undefined {
    return reviewing ?? pending[(pendingList as any).selected ?? 0];
  }

  function openReview() {
    const r = selectedPending();
    if (!r) return;
    reviewing = r;
    renderReview();
    review.show();
    review.setFront();
    screen.render();
  }

  function closeReview() {
    reviewing = null;
    review.hide();
    if (visible) screen.render();
  }

  async function approve() {
    const r = selectedPending();
    if (!r) return;
    if (!deps.macApprover || !macReady) {
      flash(fg(T.brass, 'Touch ID approval is not set up on this Mac · approve on your phone'));
      return;
    }
    flash(fg(T.brass, `Touch ID · ${esc(`${clientName(r.client)} wants to ${summaryPhrase(r.summaryEnum, r.opId)}`)}`));
    try {
      await deps.macApprover.approve(r.id);
      closeReview();
      flash(fg(T.green, '✓ Approved'));
    } catch (err: any) {
      flash(fg(T.vermilion, `✗ ${esc(err?.message ?? String(err))}`));
    }
    await refresh();
  }

  async function deny() {
    const r = selectedPending();
    if (!r) return;
    try {
      await deps.api.deny(r.id);
      pending = pending.filter((p) => p.id !== r.id);
      closeReview();
      flash(fg(T.vermilion, `Denied · ${esc(clientName(r.client))} will not ${esc(summaryPhrase(r.summaryEnum, r.opId))}`));
    } catch (err: any) {
      flash(fg(T.vermilion, `✗ ${esc(err?.message ?? String(err))}`));
    }
    await refresh();
  }

  function cycleFocus(dir: 1 | -1) {
    const i = focusOrder.findIndex((w) => screen.focused === w);
    const next = focusOrder[(i + dir + focusOrder.length) % focusOrder.length];
    next.focus();
    screen.render();
  }

  const onKey = (_ch: string, key: { full?: string; name?: string }) => {
    if (!visible || destroyed) return;
    const k = key?.full ?? key?.name;
    switch (k) {
      case 'escape':
      case 'q':
        if (reviewing) closeReview();
        else deps.onClose();
        return;
      case 'r':
        void refresh();
        return;
      case 'tab':
        cycleFocus(1);
        return;
      case 'S-tab':
        cycleFocus(-1);
        return;
      case 't':
        if (reviewing || screen.focused === pendingList) void approve();
        return;
      case 'd':
        if (reviewing || screen.focused === pendingList) void deny();
        return;
      case 'enter':
        if (screen.focused === pendingList && pending.length) openReview();
        return;
    }
  };

  agentList.on('select item', (_el: unknown, index: number) => {
    const key = agentAt(index);
    if (key === selectedAgent) return;
    selectedAgent = key;
    followBottom = true;
    renderTimeline();
    if (visible) screen.render();
  });

  screen.on('keypress', onKey);
  const onResize = () => { if (visible) renderAll(); };
  screen.on('resize', onResize);

  // ── Lifecycle ─────────────────────────────────────────────

  return {
    show() {
      if (destroyed || visible) return;
      visible = true;
      followBottom = true;
      root.show();
      root.setFront();
      (pending.length ? pendingList : agentList).focus();
      renderAll();
      Promise.resolve(deps.macApprover?.available?.() ?? !!deps.macApprover)
        .then((ok) => { macReady = !!ok; renderFooter(); if (visible) screen.render(); })
        .catch(() => { macReady = false; });
      void refresh().then(() => {
        if (visible && pending.length && screen.focused !== pendingList) pendingList.focus();
      });
      pollTimer = setInterval(() => void refresh(), pollMs);
      pulseTimer = setInterval(() => {
        pulse = !pulse;
        if (!agents.some((a) => now() - a.lastAt < LIVE_MS)) return;
        renderAgents();
        screen.render();
      }, 700);
    },
    hide() {
      if (!visible) return;
      visible = false;
      if (pollTimer) clearInterval(pollTimer);
      if (pulseTimer) clearInterval(pulseTimer);
      closeReview();
      root.hide();
      screen.render();
    },
    destroy() {
      if (destroyed) return;
      this.hide();
      destroyed = true;
      if (flashTimer) clearTimeout(flashTimer);
      screen.removeListener('keypress', onKey);
      screen.removeListener('resize', onResize);
      root.destroy();
    },
    refresh,
  };
}
