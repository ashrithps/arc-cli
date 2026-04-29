const ALLOWED_SUFFIX = '.reactor.arc.moi';

export function assertArcHost(apiUrl: string, source: string): void {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error(
      `Invalid ${source}: "${apiUrl}" is not a valid URL. ` +
      `Arc only connects to *${ALLOWED_SUFFIX} servers.`
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid ${source}: "${apiUrl}" must use https. ` +
      `Arc only connects to *${ALLOWED_SUFFIX} servers.`
    );
  }

  if (!parsed.hostname.endsWith(ALLOWED_SUFFIX)) {
    throw new Error(
      `Invalid ${source}: "${parsed.hostname}" is not an arc.moi host. ` +
      `Arc only connects to *${ALLOWED_SUFFIX} servers. ` +
      `Self-hosted Actual servers are not supported by this build.`
    );
  }
}
