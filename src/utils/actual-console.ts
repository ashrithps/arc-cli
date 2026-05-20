const NOISY_PREFIXES = [
  '[Breadcrumb]',
  '[Client] Connected to budget:',
  '[Client] Disconnected',
  'Loaded spreadsheet from cache',
  'Loading fresh spreadsheet',
  'Syncing since ',
  'Got messages from server',
  'Merkle hash in db:',
  'Performing transaction reconciliation',
  'Debug data for the operations:',
];

const NOISY_CONTAINS = [
  'Invalid rule RuleError:',
  'Error while evaluating budget',
  'res.messages:',
  'rebuilt hash:',
  'server hash:',
  'local clock:',
  'clientId ',
  'node_modules/@actual-app/api/dist/app/bundle.api.js',
  "type: 'not-string'",
];

let installed = false;
let stderrBuffer = '';
let stdoutBuffer = '';
let suppressStdoutTail = false;
let suppressStderrTail = false;

function shouldSuppress(args: any[]): boolean {
  const line = args.map(arg => String(arg)).join(' ');
  if (!line) return false;
  if (NOISY_PREFIXES.some(prefix => line.startsWith(prefix))) return true;
  if (NOISY_CONTAINS.some(fragment => line.includes(fragment))) return true;
  return false;
}

export function installActualConsoleFilter(): void {
  if (installed) return;
  // Allow opt-out via either the modern (ARC_*) or legacy (ARCTUAL_*) env
  // var name. The CLI rename to `arc` renamed the tui's set-side to the
  // modern name but missed this read-site, which silently re-enabled the
  // filter for the TUI and trapped blessed's ANSI writes in a line buffer
  // (blessed's alternate-screen / clear sequences don't contain a newline,
  // so the filter's split-on-newline logic buffered them forever and the
  // TUI looked like it was hanging). Keep accepting both names so any
  // lingering user-level overrides still work.
  if (
    process.env.ARC_DISABLE_OUTPUT_FILTER === '1' ||
    process.env.ARCTUAL_DISABLE_OUTPUT_FILTER === '1'
  ) return;
  // Direct argv check: this module is imported by `client.ts` at module-top,
  // which is in turn imported by `index.ts` at module-top, which means the
  // filter is installed BEFORE `tui/app.ts`'s env-var sets run (ESM hoists
  // imports above executable code). `process.argv` is populated before any
  // JS runs, so checking it here works where env-var sets don't. If the
  // user invoked `arc ui` — or any path whose last positional is `ui` —
  // skip installation so blessed's ANSI sequences pass through unbuffered.
  const args = process.argv.slice(2);
  if (args.includes('ui')) return;
  installed = true;

  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const filterChunk = (chunk: any, buffer: string, suppressTail: boolean) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString();
    const lines = buffer.split('\n');
    const tail = lines.pop() ?? '';
    const kept: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (shouldSuppress([line])) {
        suppressTail = true;
        continue;
      }
      if (suppressTail && (trimmed === '}' || line.startsWith('    at '))) {
        continue;
      }
      suppressTail = false;
      kept.push(line);
    }

    return {
      output: kept.length > 0 ? kept.join('\n') + '\n' : '',
      tail,
      suppressTail,
    };
  };

  console.log = (...args: any[]) => {
    if (shouldSuppress(args)) return;
    originalLog(...args);
  };

  console.warn = (...args: any[]) => {
    if (shouldSuppress(args)) return;
    originalWarn(...args);
  };

  console.error = (...args: any[]) => {
    if (shouldSuppress(args)) return;
    originalError(...args);
  };

  process.stdout.write = ((chunk: any, encoding?: any, cb?: any) => {
    const { output, tail, suppressTail } = filterChunk(chunk, stdoutBuffer, suppressStdoutTail);
    stdoutBuffer = tail;
    suppressStdoutTail = suppressTail;
    if (!output) {
      if (typeof cb === 'function') cb();
      return true;
    }
    return originalStdoutWrite(output, encoding, cb);
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: any, encoding?: any, cb?: any) => {
    const { output, tail, suppressTail } = filterChunk(chunk, stderrBuffer, suppressStderrTail);
    stderrBuffer = tail;
    suppressStderrTail = suppressTail;
    if (!output) {
      if (typeof cb === 'function') cb();
      return true;
    }
    return originalStderrWrite(output, encoding, cb);
  }) as typeof process.stderr.write;
}

installActualConsoleFilter();
