/**
 * The agent activity timeline, printed.
 *
 * Ported from vault's agent timeline: days, each a run of sessions on a left
 * rail. A session is one sitting of one agent on one machine (no gap over ten
 * minutes), headed once, its steps beneath it without the agent's name
 * repeated. Colour carries meaning and nothing else: vermilion when something
 * was refused, brass when something waits on you or looks wrong, ink for what
 * happened, grey for reads. Each node keeps the contract's distinction between
 * what the server witnessed (●), what an agent reported from the machine (◇),
 * and what you did yourself (○). An approval sits under the op it unlocked.
 *
 * The same renderer feeds the TUI, which wants blessed tags instead of ANSI,
 * so painting goes through a small `Paint` with two implementations.
 */
import { Chalk } from 'chalk';
import type {
  AuditHeadWire,
  AuditPageWire,
  AuditRowWire,
  Decision,
  PendingRequestSummaryWire,
  Risk,
  SelfResponse,
} from './wire.js';
import { verifyChain, type ChainVerdict } from './chain.js';
import {
  approvalPhrase,
  clientName,
  interpret,
  opPhrase,
  opTail,
  presetName,
  summaryPhrase,
  type ActivityJournal,
  type InterpretContext,
  type MachineInfo,
} from './interpret.js';

export type { ActivityJournal, JournalNote, MachineInfo } from './interpret.js';

// ── Options ─────────────────────────────────────────────────────────────────

export interface RenderOptions {
  /** Columns; clamped to at least 60. Default: the terminal's, or 100. */
  width?: number;
  /** Default: stdout is a TTY and NO_COLOR is unset. */
  color?: boolean;
  /** 'blessed' emits blessed tags for the TUI instead of ANSI. */
  markup?: 'ansi' | 'blessed';
  now?: number;
  /** IANA zone for day boundaries and clock times. Default: the machine's. */
  tz?: string;
  /** With a head, the chain is verified and a footer printed. */
  head?: AuditHeadWire;
  /** A verdict computed elsewhere (e.g. over more rows than are shown). */
  verdict?: ChainVerdict;
  /** connectionId → name for the machine. */
  connections?: Record<string, MachineInfo>;
}

const MIN_WIDTH = 60;
const SESSION_GAP_MS = 10 * 60 * 1000;
const REQUEST_TTL_MS = 10 * 60 * 1000;

export function defaultRenderOptions(stream: NodeJS.WriteStream = process.stdout): Required<Pick<RenderOptions, 'width' | 'color'>> {
  return {
    width: Math.max(MIN_WIDTH, stream.columns || 100),
    color: !!stream.isTTY && !process.env.NO_COLOR,
  };
}

// ── Paint ───────────────────────────────────────────────────────────────────

const HUE = {
  vermilion: '#E5533D',
  brass: '#C9A44C',
  grey: '#8A8F98',
  faint: '#5A5F69',
  green: '#6FBF8E',
};

type Tone = 'ink' | 'dim' | 'vermilion' | 'brass';

interface Paint {
  text(s: string): string; // escape only
  bold(s: string): string;
  dim(s: string): string;
  faint(s: string): string;
  vermilion(s: string): string;
  brass(s: string): string;
  green(s: string): string;
  boldDim(s: string): string;
  tone(t: Tone, s: string): string;
}

function makePaint(opts: RenderOptions): Paint {
  const color = opts.color ?? defaultRenderOptions().color;
  if (opts.markup === 'blessed') {
    const esc = (s: string) => s.replace(/[{}]/g, (c) => (c === '{' ? '{open}' : '{close}'));
    const fg = (hex: string) => (s: string) => (color ? `{${hex}-fg}${esc(s)}{/${hex}-fg}` : esc(s));
    const p: Paint = {
      text: esc,
      bold: (s) => (color ? `{bold}${esc(s)}{/bold}` : esc(s)),
      dim: fg(HUE.grey),
      faint: fg(HUE.faint),
      vermilion: fg(HUE.vermilion),
      brass: fg(HUE.brass),
      green: fg(HUE.green),
      boldDim: (s) => (color ? `{bold}{${HUE.grey}-fg}${esc(s)}{/${HUE.grey}-fg}{/bold}` : esc(s)),
      tone: (t, s) => (t === 'ink' ? esc(s) : t === 'dim' ? p.dim(s) : p[t](s)),
    };
    return p;
  }
  const c = new Chalk({ level: color ? 3 : 0 });
  const p: Paint = {
    text: (s) => s,
    bold: (s) => c.bold(s),
    dim: (s) => c.hex(HUE.grey)(s),
    faint: (s) => c.hex(HUE.faint)(s),
    vermilion: (s) => c.hex(HUE.vermilion)(s),
    brass: (s) => c.hex(HUE.brass)(s),
    green: (s) => c.hex(HUE.green)(s),
    boldDim: (s) => c.bold.hex(HUE.grey)(s),
    tone: (t, s) => (t === 'ink' ? s : t === 'dim' ? p.dim(s) : p[t](s)),
  };
  return p;
}

/** Terminal columns a plain string occupies. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 32 || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0x1f300 && cp <= 0x1faff)
    ) w += 2;
    else w += 1;
  }
  return w;
}

function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  if (displayWidth(s) <= max) return s;
  let out = '';
  for (const ch of s) {
    if (displayWidth(out + ch) > max - 1) break;
    out += ch;
  }
  return out.trimEnd() + '…';
}

function spaces(n: number): string {
  return n > 0 ? ' '.repeat(n) : '';
}

// ── Time ────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function parts(ts: number, tz: string | undefined) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric', month: 'short', day: 'numeric', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const out: Record<string, string> = {};
  for (const p of f.formatToParts(ts)) out[p.type] = p.value;
  return {
    key: `${out.year}-${out.month}-${out.day.padStart(2, '0')}`,
    year: out.year,
    weekday: out.weekday,
    month: out.month,
    day: out.day,
    clock: `${out.hour}:${out.minute}`,
  };
}

export function clock(ts: number, tz?: string): string {
  return parts(ts, tz).clock;
}

function dayLabel(ts: number, now: number, tz: string | undefined): string {
  const p = parts(ts, tz);
  const date = `${p.weekday} ${p.day} ${p.month}${p.year !== parts(now, tz).year ? ` ${p.year}` : ''}`.toUpperCase();
  if (p.key === parts(now, tz).key) return `TODAY · ${date}`;
  if (p.key === parts(now - DAY_MS, tz).key) return `YESTERDAY · ${date}`;
  return date;
}

/** "3m", "1h 20m", "2d". */
export function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ── Model ───────────────────────────────────────────────────────────────────

type Node = '●' | '◇' | '○';

interface Nested { text: string; tone: Tone; at?: number }

interface Item {
  at: number;
  connectionId?: string;
  client?: string;
  /** Something the agent did, which can join a session. */
  agentActed: boolean;
  node: Node;
  tone: Tone;
  risk?: Risk;
  /** Sentence with and without the agent's name at the front. */
  full: string;
  bare: string;
  nested: Nested[];
  rows: AuditRowWire[];
}

function nodeOf(row: AuditRowWire): Node {
  if (row.source === 'phone') return '○';
  if (row.source === 'agent' || row.detail?.offline) return '◇';
  return '●';
}

function opTone(row: AuditRowWire): Tone {
  if (row.detail?.result === 'error') return 'brass';
  return row.risk === 'read' ? 'dim' : 'ink';
}

function eventTone(row: AuditRowWire): Tone {
  switch (row.kind) {
    case 'op.denied':
    case 'request.denied':
    case 'connection.denied':
    case 'client.blocked':
      return 'vermilion';
    case 'mismatch':
      return 'brass';
    case 'request.expired':
    case 'request.cancelled':
    case 'client.first_seen':
      return 'dim';
    default:
      return 'ink';
  }
}

const AGENT_KINDS = new Set(['op.allowed', 'op.denied', 'op.completed', 'request.created', 'request.consumed', 'mismatch', 'client.first_seen']);

function single(row: AuditRowWire, ctx: InterpretContext): Item {
  const isOp = row.kind === 'op.allowed' || row.kind === 'op.completed' || row.kind === 'request.consumed';
  return {
    at: row.at,
    connectionId: row.connectionId,
    client: row.client,
    agentActed: AGENT_KINDS.has(row.kind) && !!row.client && !!row.connectionId,
    node: nodeOf(row),
    tone: isOp ? opTone(row) : eventTone(row),
    risk: row.opId ? row.risk : undefined,
    full: interpret(row, ctx),
    bare: interpret(row, ctx, true),
    nested: [],
    rows: [row],
  };
}

/** A request's whole life — asked, answered, run — as one line and its consequences beneath. */
function requestItem(rows: AuditRowWire[], ctx: InterpretContext, now: number): Item {
  const created = rows.find((r) => r.kind === 'request.created') ?? rows[0];
  const approved = rows.find((r) => r.kind === 'request.approved');
  const denied = rows.find((r) => r.kind === 'request.denied');
  const expired = rows.find((r) => r.kind === 'request.expired');
  const cancelled = rows.find((r) => r.kind === 'request.cancelled');
  const ran = rows.find((r) => r.kind === 'op.completed') ?? rows.find((r) => r.kind === 'request.consumed');
  const base = single(created, ctx);
  const tailFrom = (r: AuditRowWire) => {
    for (const row of [r, ...rows]) {
      const t = opTail(row, ctx);
      if (t.length) return t;
    }
    return [];
  };
  const agent = clientName(created.client);
  const say = (bare: string, tail: string[]) => {
    const b = [bare.charAt(0).toUpperCase() + bare.slice(1), ...tail].join(' · ');
    return { bare: b, full: [`${agent} ${bare}`, ...tail].join(' · ') };
  };

  const nested: Nested[] = [];
  let tone: Tone = 'ink';
  let sentence: { bare: string; full: string };
  if (ran) {
    sentence = say(opPhrase(created.opId, 'past'), tailFrom(ran));
    tone = ran.detail?.result === 'error' ? 'brass' : 'ink';
  } else {
    sentence = say(`asked to ${opPhrase(created.opId, 'present')}`, tailFrom(created));
  }
  if (approved) nested.push({ text: approvalPhrase(approved), tone: 'ink', at: approved.at });
  if (denied) {
    nested.push({ text: 'you denied it', tone: 'vermilion', at: denied.at });
    tone = 'vermilion';
  } else if (expired) {
    nested.push({ text: 'expired unanswered', tone: 'dim', at: expired.at });
    tone = 'dim';
  } else if (cancelled) {
    nested.push({ text: 'withdrawn by the agent', tone: 'dim', at: cancelled.at });
    tone = 'dim';
  } else if (approved && !ran) {
    nested.push({ text: 'not run yet', tone: 'dim' });
  } else if (!approved) {
    const left = created.at + REQUEST_TTL_MS - now;
    if (left > 0) {
      nested.push({ text: `waiting on you · ${span(left)} left`, tone: 'brass' });
      tone = 'brass';
    } else {
      nested.push({ text: 'unanswered', tone: 'dim' });
      tone = 'dim';
    }
  }
  if (created.mismatch) nested.push({ text: 'from a connection made for another agent', tone: 'brass' });
  return { ...base, ...sentence, tone, nested, rows, node: nodeOf(ran ?? created) };
}

/** Rows (any order) → display items, oldest first. */
function itemsOf(entries: readonly AuditRowWire[], ctx: InterpretContext, now: number): Item[] {
  const rows = [...entries].sort((a, b) => a.seq - b.seq);
  const byRequest = new Map<string, AuditRowWire[]>();
  for (const r of rows) {
    if (r.requestId) byRequest.set(r.requestId, [...(byRequest.get(r.requestId) ?? []), r]);
  }
  const items: Item[] = [];
  const seenRequests = new Set<string>();
  /** op.allowed items still waiting for their op.completed. */
  const open: Item[] = [];
  for (const r of rows) {
    if (r.requestId && r.kind !== 'notice.sent' && r.kind !== 'grant.revoked') {
      if (seenRequests.has(r.requestId)) continue;
      seenRequests.add(r.requestId);
      items.push(requestItem(byRequest.get(r.requestId)!, ctx, now));
      continue;
    }
    if (r.kind === 'op.completed') {
      const i = open.findIndex((it) => it.connectionId === r.connectionId && it.client === r.client && it.rows[0].opId === r.opId);
      if (i >= 0) {
        const it = open.splice(i, 1)[0];
        const merged = single(r, ctx);
        it.rows.push(r);
        it.full = merged.full;
        it.bare = merged.bare;
        it.tone = merged.tone;
        continue;
      }
    }
    // Notices duplicate what the timeline already shows.
    if (r.kind === 'notice.sent') continue;
    const it = single(r, ctx);
    if (r.kind === 'op.allowed') open.push(it);
    items.push(it);
  }
  return items;
}

interface Session { connectionId?: string; client?: string; items: Item[]; start: number; end: number }

function sessionsOf(items: Item[]): Session[] {
  const out: Session[] = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (
      prev &&
      it.agentActed &&
      prev.items[prev.items.length - 1].agentActed &&
      prev.connectionId === it.connectionId &&
      prev.client === it.client &&
      it.at - prev.end <= SESSION_GAP_MS
    ) {
      prev.items.push(it);
      prev.end = it.at;
      continue;
    }
    out.push({ connectionId: it.connectionId, client: it.client, items: [it], start: it.at, end: it.at });
  }
  return out;
}

function sessionMachine(s: Session, ctx: InterpretContext): string | undefined {
  const m = s.connectionId ? ctx.connections?.[s.connectionId] : undefined;
  if (m?.label || m?.hostname) return m.label || m.hostname;
  for (const it of s.items) {
    for (const r of it.rows) {
      const h = ctx.journal?.lookup(r)?.hostname;
      if (h) return h;
    }
  }
  return undefined;
}

// ── Activity ────────────────────────────────────────────────────────────────

const GUTTER = '  ';
/** Columns before an item's text: gutter, node, two spaces, badge (4). */
const TEXT_COL = GUTTER.length + 1 + 2 + 4;

function badge(p: Paint, risk: Risk | undefined, tone: Tone): string {
  if (risk === 'destructive') return (tone === 'ink' || tone === 'dim' ? p.bold('DEL') : p.tone(tone, 'DEL')) + ' ';
  if (risk === 'write') return (tone === 'ink' ? p.dim('W') : p.tone(tone, 'W')) + '   ';
  return '    ';
}

function railLine(p: Paint): string {
  return GUTTER + p.faint('│');
}

/** "left ……… right", the right edge at `width`. */
function justify(left: string, leftWidth: number, right: string, rightWidth: number, width: number): string {
  if (!rightWidth) return left;
  return left + spaces(width - leftWidth - rightWidth) + right;
}

function itemLines(it: Item, sentence: string, p: Paint, width: number, tz: string | undefined): string[] {
  const time = clock(it.at, tz);
  const room = width - TEXT_COL - time.length - 2;
  const text = truncate(sentence, room);
  const node =
    it.tone === 'vermilion' ? p.vermilion(it.node) : it.tone === 'brass' ? p.brass(it.node) : it.node === '●' && it.tone !== 'dim' ? it.node : p.dim(it.node);
  const left = `${GUTTER}${node}  ${badge(p, it.risk, it.tone)}${p.tone(it.tone, text)}`;
  const lines = [justify(left, TEXT_COL + displayWidth(text), p.faint(time), time.length, width)];
  for (const n of it.nested) {
    const t = n.at !== undefined ? clock(n.at, tz) : '';
    const lead = `${GUTTER}${p.faint('│')}${spaces(TEXT_COL - GUTTER.length - 1)}`;
    const body = truncate(n.text, width - TEXT_COL - 2 - t.length - 2);
    lines.push(justify(`${lead}${p.faint('└')} ${p.tone(n.tone, body)}`, TEXT_COL + 2 + displayWidth(body), p.faint(t), t.length, width));
  }
  return lines;
}

function sessionHeader(s: Session, ctx: InterpretContext, p: Paint, width: number, tz: string | undefined): string {
  const name = clientName(s.client);
  const machine = sessionMachine(s, ctx);
  const n = s.items.length;
  const rest = [machine, `${n} ${n === 1 ? 'action' : 'actions'}`].filter(Boolean).join(' · ');
  const a = clock(s.start, tz);
  const b = clock(s.end, tz);
  const when = a === b ? a : `${a}–${b}`;
  const lead = `${GUTTER}${p.faint('├──')} `;
  const leadW = GUTTER.length + 4;
  const room = width - leadW - when.length - 4;
  let label = `${name} · ${rest}`;
  if (displayWidth(label) > room) label = truncate(label, room);
  const painted = displayWidth(label) > displayWidth(name)
    ? p.bold(name) + p.dim(label.slice(name.length))
    : p.bold(label);
  const used = leadW + displayWidth(label);
  const rule = width - used - when.length - 2;
  return `${lead}${painted} ${p.faint('─'.repeat(Math.max(1, rule)))} ${p.dim(when)}`;
}

function footer(verdict: ChainVerdict, count: number, p: Paint, width: number): string[] {
  const inner = Math.min(width - 4, 72);
  if (verdict.ok) {
    const left = verdict.verifiedThrough
      ? `${p.green('✓')} ${p.dim('Chain verified through')} ${p.bold(`#${verdict.verifiedThrough.toLocaleString('en-US')}`)}`
      : `${p.dim('· Nothing to verify yet')}`;
    const leftW = verdict.verifiedThrough
      ? 2 + 'Chain verified through '.length + 1 + verdict.verifiedThrough.toLocaleString('en-US').length
      : '· Nothing to verify yet'.length;
    const right = `${count.toLocaleString('en-US')} ${count === 1 ? 'entry' : 'entries'}`;
    return [
      GUTTER + p.faint('─'.repeat(width - GUTTER.length * 2)),
      justify(GUTTER + left, GUTTER.length + leftW, p.dim(right), right.length, width - GUTTER.length),
    ];
  }
  const at = verdict.breakAt !== undefined ? `#${verdict.breakAt.toLocaleString('en-US')}` : 'an unknown row';
  const why: Record<string, string> = {
    hash: 'its recorded hash does not match its contents.',
    link: 'it does not point at the row before it.',
    gap: 'rows before it are missing.',
    genesis: 'the first row does not start the chain.',
    anchor: 'it does not match the server’s anchor.',
    head: 'it does not match the server’s head.',
  };
  const body = [
    `✗  AUDIT CHAIN BROKEN AT ${at}`,
    '',
    `Row ${at} fails verification: ${why[verdict.reason ?? 'hash']}`,
    'This history may have been altered after it was written.',
    verdict.verifiedThrough
      ? `Everything up to #${verdict.verifiedThrough.toLocaleString('en-US')} checks out; nothing after it can be trusted.`
      : 'None of these rows can be trusted.',
  ];
  const wrap = (s: string): string[] => {
    if (displayWidth(s) <= inner - 4) return [s];
    const words = s.split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      if (displayWidth(cur ? `${cur} ${w}` : w) > inner - 4) {
        lines.push(cur);
        cur = w;
      } else cur = cur ? `${cur} ${w}` : w;
    }
    if (cur) lines.push(cur);
    return lines;
  };
  const v = p.vermilion;
  const out = ['', GUTTER + v(`╔${'═'.repeat(inner - 2)}╗`)];
  body.flatMap(wrap).forEach((line, i) => {
    const txt = i === 0 ? p.bold(v(line)) : line ? v(line) : '';
    out.push(`${GUTTER}${v('║')} ${txt}${spaces(inner - 4 - displayWidth(line))} ${v('║')}`);
  });
  out.push(GUTTER + v(`╚${'═'.repeat(inner - 2)}╝`));
  return out;
}

/** Where a rendering stopped, so the next batch (`--follow`) can carry on seamlessly. */
export interface TimelineCursor {
  day?: string;
  session?: { connectionId?: string; client?: string; end: number; agentActed: boolean };
}

export interface RenderResult { text: string; cursor: TimelineCursor }

/** The printed timeline for `arc activity`. */
export function renderActivity(
  entries: readonly AuditRowWire[],
  journal?: ActivityJournal,
  opts: RenderOptions = {},
): string {
  return renderActivityFrom(entries, journal, opts).text;
}

/**
 * The same, starting after `cursor`: a day already headed is not headed again,
 * and a session still going continues without a second header.
 */
export function renderActivityFrom(
  entries: readonly AuditRowWire[],
  journal: ActivityJournal | undefined,
  opts: RenderOptions = {},
  cursor: TimelineCursor = {},
  { footer: withFooter = true }: { footer?: boolean } = {},
): RenderResult {
  const p = makePaint(opts);
  const width = Math.max(MIN_WIDTH, opts.width ?? defaultRenderOptions().width);
  const now = opts.now ?? Date.now();
  const tz = opts.tz;
  const ctx: InterpretContext = { journal, connections: opts.connections };
  const items = itemsOf(entries, ctx, now);
  const out: string[] = [];
  const next: TimelineCursor = { ...cursor };

  if (!items.length && !cursor.day) {
    out.push('', `${GUTTER}${p.dim('No agent activity yet.')}`, `${GUTTER}${p.faint('Pair a machine from arc on your phone, then run an agent here.')}`);
  }

  // Day → sessions.
  const days: { key: string; at: number; items: Item[] }[] = [];
  for (const it of items) {
    const key = parts(it.at, tz).key;
    const last = days[days.length - 1];
    if (last?.key === key) last.items.push(it);
    else days.push({ key, at: it.at, items: [it] });
  }

  for (const day of days) {
    const continuing = day.key === next.day;
    if (!continuing) {
      out.push('', `${GUTTER}${p.boldDim(dayLabel(day.at, now, tz))}`);
      next.session = undefined;
    }
    const sessions = sessionsOf(day.items);
    sessions.forEach((s, si) => {
      const prev = next.session;
      const continues =
        si === 0 && continuing && prev && prev.agentActed && s.items[0].agentActed &&
        prev.connectionId === s.connectionId && prev.client === s.client && s.start - prev.end <= SESSION_GAP_MS;
      const grouped = continues || s.items.length > 1;
      const prevLone = si > 0 && sessions[si - 1].items.length === 1;
      if (!continues && !(prevLone && !grouped)) {
        out.push(railLine(p));
        if (s.items.length > 1) out.push(sessionHeader(s, ctx, p, width, tz));
      }
      for (const it of s.items) out.push(...itemLines(it, grouped ? it.bare : it.full, p, width, tz));
      const last = s.items[s.items.length - 1];
      next.session = { connectionId: s.connectionId, client: s.client, end: s.end, agentActed: last.agentActed };
    });
    next.day = day.key;
  }

  if (withFooter) {
    const verdict = opts.verdict ?? (opts.head ? verifyChain(entries, opts.head) : undefined);
    if (verdict) out.push('', ...footer(verdict, entries.length, p, width));
  }
  if (out.length) out.push('');
  return { text: out.join('\n'), cursor: next };
}

// ── Follow ──────────────────────────────────────────────────────────────────

export interface ActivityQuery { afterSeq?: number; limit?: number; client?: string }

/** The slice of `AgentApi` that `--follow` needs. */
export interface ActivitySource {
  activity(params: ActivityQuery): Promise<AuditPageWire>;
}

export interface FollowHandle {
  stop(): void;
  /** Resolves after the poll in flight, if any. */
  readonly idle: Promise<void>;
}

/**
 * Poll `/activity` for rows after the last seen seq and hand over each new
 * batch. The first poll runs at once; polls never overlap; errors go to
 * `onError` and polling carries on.
 */
export function followActivity(
  api: ActivitySource,
  onEntries: (entries: AuditRowWire[], head: AuditHeadWire) => void,
  intervalMs = 3000,
  opts: { afterSeq?: number; client?: string; limit?: number; onError?: (err: unknown) => void } = {},
): FollowHandle {
  let afterSeq = opts.afterSeq ?? 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: Promise<void> = Promise.resolve();

  const tick = async () => {
    try {
      for (;;) {
        const page = await api.activity({ afterSeq, client: opts.client, limit: opts.limit });
        if (stopped) return;
        const fresh = page.entries.filter((e) => e.seq > afterSeq).sort((a, b) => a.seq - b.seq);
        if (fresh.length) {
          afterSeq = fresh[fresh.length - 1].seq;
          onEntries(fresh, page.head);
        }
        // A full page means more may be waiting: drain before sleeping.
        if (!opts.limit || page.entries.length < opts.limit || !fresh.length) break;
      }
    } catch (err) {
      opts.onError?.(err);
    }
  };
  const loop = () => {
    if (stopped) return;
    idle = tick().then(() => {
      if (!stopped) timer = setTimeout(loop, intervalMs);
    });
  };
  loop();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    get idle() {
      return idle;
    },
  };
}

// ── Pending ─────────────────────────────────────────────────────────────────

/** `arc approvals list`: what is waiting on you. */
export function renderPending(requests: readonly PendingRequestSummaryWire[], opts: RenderOptions = {}): string {
  const p = makePaint(opts);
  const width = Math.max(MIN_WIDTH, opts.width ?? defaultRenderOptions().width);
  const now = opts.now ?? Date.now();
  const out: string[] = [''];
  if (!requests.length) {
    out.push(`${GUTTER}${p.green('✓')} ${p.dim('Nothing is waiting on you.')}`, '');
    return out.join('\n');
  }
  const n = requests.length;
  out.push(`${GUTTER}${p.boldDim(`${n} WAITING ON YOU`)}`, railLine(p));
  const sorted = [...requests].sort((a, b) => a.createdAt - b.createdAt);
  sorted.forEach((r, i) => {
    const sentence = `${clientName(r.client)} wants to ${summaryPhrase(r.summaryEnum, r.opId)}`;
    const left = r.expiresAt - now;
    const right = left > 0 ? `${span(left)} left` : 'expired';
    const room = width - TEXT_COL - right.length - 2;
    const text = truncate(sentence, room);
    const head = `${GUTTER}${p.brass('◆')}  ${badge(p, r.risk, 'ink')}${p.bold(text)}`;
    out.push(justify(head, TEXT_COL + displayWidth(text), left > 0 ? p.brass(right) : p.dim(right), right.length, width));
    const meta = `${r.id} · ${r.opId} · asked ${span(now - r.createdAt)} ago`;
    out.push(`${GUTTER}${p.faint(i === sorted.length - 1 ? ' ' : '│')}${spaces(TEXT_COL - GUTTER.length - 1)}${p.dim(truncate(meta, width - TEXT_COL))}`);
  });
  out.push('');
  return out.join('\n');
}

// ── Whoami ──────────────────────────────────────────────────────────────────

const PRESET_TABLE: Record<string, Record<Risk, Decision>> = {
  full: { read: 'allow', write: 'allow', destructive: 'allow' },
  standard: { read: 'allow', write: 'ask', destructive: 'ask' },
  private: { read: 'ask', write: 'ask', destructive: 'ask' },
};

/** The groups every policy speaks about, in the order the CLI lists them. */
export const POLICY_GROUPS = [
  'accounts', 'transactions', 'categories', 'payees', 'tags', 'rules', 'schedules',
  'budgets', 'query', 'portfolio', 'goals', 'splits', 'server',
];

function decisionCell(p: Paint, d: Decision, w: number): string {
  const word = d === 'allow' ? 'Allow' : d === 'ask' ? 'Ask' : 'Deny';
  const mark = d === 'allow' ? '●' : d === 'ask' ? '◐' : '○';
  const s = `${mark} ${word}`;
  const painted = d === 'allow' ? p.green(s) : d === 'ask' ? p.brass(s) : p.vermilion(s);
  return painted + spaces(w - s.length);
}

/** `arc agents whoami`: this connection, the effective policy, active grants. */
export function renderWhoami(self: SelfResponse, opts: RenderOptions & { groups?: string[] } = {}): string {
  const p = makePaint(opts);
  const width = Math.max(MIN_WIDTH, opts.width ?? defaultRenderOptions().width);
  const now = opts.now ?? self.serverTime ?? Date.now();
  const { connection, policy } = self;
  const out: string[] = [''];

  const state = connection.status !== 'active'
    ? { word: connection.status.toUpperCase(), paint: p.vermilion }
    : connection.paused
      ? { word: 'PAUSED', paint: p.vermilion }
      : self.blocked
        ? { word: 'BLOCKED', paint: p.vermilion }
        : { word: 'ACTIVE', paint: p.green };
  const who = `${connection.label}${policy.client && policy.client !== '*' ? ` · ${clientName(policy.client)}` : ''}`;
  const whoT = truncate(who, width - GUTTER.length * 2 - state.word.length - 4);
  out.push(justify(`${GUTTER}${p.bold(whoT)}`, GUTTER.length + displayWidth(whoT), state.paint(`● ${state.word}`), state.word.length + 2, width - GUTTER.length));
  const mac = policy.macApprovalMaxRisk === 'none' ? 'off' : `up to ${policy.macApprovalMaxRisk === 'destructive' ? 'Delete' : 'Write'}`;
  out.push(`${GUTTER}${p.dim(`${presetName(policy.preset)} preset · Touch ID approvals ${mac} · ${connection.id}`)}`);
  if (connection.intendedClient && policy.client && policy.client !== '*' && connection.intendedClient !== policy.client) {
    out.push(`${GUTTER}${p.brass(`⚠ Paired for ${clientName(connection.intendedClient)}, used by ${clientName(policy.client)}`)}`);
  }

  // Group × risk matrix.
  const groups = [...(opts.groups ?? POLICY_GROUPS)];
  for (const o of policy.groupOverrides) if (!groups.includes(o.group)) groups.push(o.group);
  const nameW = Math.max(...groups.map((g) => g.length)) + 3;
  const cellW = 10;
  const base = PRESET_TABLE[policy.preset] ?? PRESET_TABLE.standard;
  const risks: Risk[] = ['read', 'write', 'destructive'];
  out.push('', `${GUTTER}${spaces(nameW)}${p.boldDim('READ'.padEnd(cellW))}${p.boldDim('WRITE'.padEnd(cellW))}${p.boldDim('DELETE')}`);
  out.push(`${GUTTER}${p.faint('─'.repeat(nameW + cellW * 3 - 2))}`);
  for (const g of groups) {
    let changed = false;
    const cells = risks.map((r) => {
      const o = policy.groupOverrides.find((x) => x.group === g && x.risk === r);
      if (o) changed = true;
      const d: Decision = connection.paused || self.blocked ? 'deny' : o?.decision ?? base[r];
      return decisionCell(p, d, cellW);
    });
    out.push(`${GUTTER}${(changed ? p.bold : p.text)(g.padEnd(nameW))}${cells.join('')}${changed ? p.faint('  ✎') : ''}`.trimEnd());
  }
  if (policy.opOverrides.length) {
    out.push('', `${GUTTER}${p.boldDim('EXCEPTIONS')}`);
    const opW = Math.max(nameW + cellW, ...policy.opOverrides.map((o) => o.opId.length + 3));
    for (const o of policy.opOverrides) out.push(`${GUTTER}${o.opId.padEnd(opW)}${decisionCell(p, o.decision, cellW)}`.trimEnd());
  }

  // Grants.
  const grants = self.grants.filter((g) => !g.revokedAt && g.expiresAt > now);
  out.push('', `${GUTTER}${p.boldDim('STANDING APPROVALS')}`);
  if (!grants.length) out.push(`${GUTTER}${p.dim('None. Everything marked Ask asks every time.')}`);
  for (const g of grants) {
    const what = `${g.opId ?? `${g.group} · ${g.risk === 'destructive' ? 'delete' : g.risk}`}${g.client && g.client !== '*' ? ` · ${clientName(g.client)}` : ''}`;
    const total = Math.max(1, g.expiresAt - g.createdAt);
    const left = g.expiresAt - now;
    const barW = 12;
    const fill = Math.max(0, Math.min(barW, Math.round((left / total) * barW)));
    const right = `${span(left)} left`;
    const bar = p.brass('━'.repeat(fill)) + p.faint('─'.repeat(barW - fill));
    const room = width - GUTTER.length * 2 - barW - right.length - 6;
    const text = truncate(what, room);
    out.push(justify(`${GUTTER}${p.brass('◷')} ${text}`, GUTTER.length + 2 + displayWidth(text), `${bar}  ${p.dim(right)}`, barW + 2 + right.length, width - GUTTER.length));
  }
  if (self.pendingCount) {
    out.push('', `${GUTTER}${p.brass(`◆ ${self.pendingCount} ${self.pendingCount === 1 ? 'request is' : 'requests are'} waiting on you`)}`);
  }
  out.push('');
  return out.join('\n');
}
