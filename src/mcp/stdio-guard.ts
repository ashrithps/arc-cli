/**
 * Over `arc mcp` (stdio), stdout *is* the protocol: every byte on it must be
 * a JSON-RPC frame the SDK's transport wrote. Any `console.log` from our own
 * code, from @actual-app/api (which logs sync progress) or from a dependency
 * lands between frames and the client sees a corrupt stream.
 *
 * The SDK's StdioServerTransport writes with `process.stdout.write` directly,
 * never through `console`, so sending console.log / info / debug to stderr
 * keeps the protocol intact and still shows the message in the client's
 * server log. Installed once, before the transport connects.
 */
let guarded = false;

export function keepStdoutForProtocol(): void {
  if (guarded) return;
  guarded = true;
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}
