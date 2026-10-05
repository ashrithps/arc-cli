/**
 * The op list the phone's policy editor shows, uploaded by the CLI
 * (`PUT /catalog`) so the app never hardcodes 90-odd operations. Sent at
 * pairing and again whenever the installed CLI's catalog changes.
 */
import { PUBLIC_OPERATIONS } from '../public-surface/operation-registry.js';
import { getLocalVersion } from '../version.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import { updateConnectionState, type AgentConnectionState } from './connection.js';
import type { AgentApi } from './api.js';
import type { CatalogWire } from './wire.js';

export function buildCatalog(): CatalogWire {
  const ops = PUBLIC_OPERATIONS.map(op => ({ id: op.id, group: op.group, risk: op.risk, description: op.description }));
  const stamp = getLocalVersion();
  // A dev checkout has no stamp; the catalog's own hash still changes when an op does.
  const cliVersion = stamp
    ? `${stamp.version}+${stamp.commit.slice(0, 8)}`
    : `dev+${sha256Hex(canonicalJson(ops)).slice(0, 8)}`;
  return { cliVersion, ops };
}

export async function uploadCatalogIfChanged(
  api: AgentApi, state: AgentConnectionState, env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  const catalog = buildCatalog();
  if (state.catalogVersion === catalog.cliVersion) return false;
  await api.putCatalog(catalog);
  updateConnectionState({ catalogVersion: catalog.cliVersion }, env);
  return true;
}
