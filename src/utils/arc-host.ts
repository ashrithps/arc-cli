const REACTOR_SUFFIX = '.reactor.arc.moi';
// ArcReactor creates managed Actual services with the `ab-` service prefix in
// its controlled Cloud Run project/region. This is intentionally not a general
// `*.run.app` allowance.
const MANAGED_CLOUD_RUN_HOST = /^ab-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-z6lmrduzva-ew\.a\.run\.app$/;

function isArcManagedHost(hostname: string): boolean {
  return hostname.endsWith(REACTOR_SUFFIX) || MANAGED_CLOUD_RUN_HOST.test(hostname);
}

export function assertArcHost(apiUrl: string, source: string): void {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error(
      `Invalid ${source}: "${apiUrl}" is not a valid URL. ` +
      'Arc only connects to verified arc-managed servers.'
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid ${source}: "${apiUrl}" must use https. ` +
      'Arc only connects to verified arc-managed servers.'
    );
  }

  if (!isArcManagedHost(parsed.hostname)) {
    throw new Error(
      `Invalid ${source}: "${parsed.hostname}" is not an arc-managed host. ` +
      'Arc only connects to verified arc-managed servers. ' +
      'Self-hosted Actual servers are not supported by this build.'
    );
  }
}
