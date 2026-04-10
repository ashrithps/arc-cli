const NOISY_PREFIXES = [
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
  if (process.env.ARCTUAL_DISABLE_OUTPUT_FILTER === '1') return;
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
