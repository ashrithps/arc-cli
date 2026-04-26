/**
 * Shared types for the Arc public operation registry.
 *
 * The registry is a single source of truth that drives:
 *   - MCP tool registration (`src/mcp/server.ts`)
 *   - README / SKILL.md documentation generation
 *   - CLI parity drift guards in tests
 *
 * Each PublicOperation describes one user-visible Arc CLI subcommand.
 * Runtime / admin commands (ui, mcp, auth bootstrap, daemon/session, config show,
 * backup) intentionally do NOT appear here — they are not part of the public
 * data-plane surface.
 */

import type { ZodRawShape } from "zod";

export type PublicOperationGroup =
  | "accounts"
  | "transactions"
  | "categories"
  | "payees"
  | "tags"
  | "rules"
  | "schedules"
  | "budgets"
  | "query";

export type PublicOperationMode = "read" | "write";

export type PublicOperationExposure = "default" | "advanced";

export interface PublicOperation {
  /** Stable identifier — `${group}.${subcommand}`. */
  id: string;
  /** Top-level CLI command group. */
  group: PublicOperationGroup;
  /**
   * Canonical CLI subcommand name. When the dispatcher accepts aliases
   * (e.g. `budgets show` / `budgets month`), use the canonical form here
   * and surface the alias in `aliases`.
   */
  subcommand: string;
  /** Optional CLI aliases the dispatcher also accepts for this subcommand. */
  aliases?: string[];
  /** MCP tool name — `arc_<group>_<subcommand_with_underscores>`. */
  mcpTool: string;
  /** Whether this operation mutates Actual data. */
  mode: PublicOperationMode;
  /** One-line human description used in MCP + docs. */
  description: string;
  /** Concrete CLI usage examples (rendered into README/SKILL). */
  examples: string[];
  /**
   * Zod raw shape (object literal of zod schemas) describing the inputs the
   * operation accepts. Typed as `ZodRawShape` so consumers can adapt it to
   * either `z.object(shape)` (for validation) or pass it directly to
   * `@modelcontextprotocol/sdk`'s `registerTool({ inputSchema })`.
   */
  inputSchema: ZodRawShape;
  /**
   * Default exposure tier:
   *   - "default"  → always exposed in MCP / docs
   *   - "advanced" → opt-in (dangerous, batch, or rarely-used operations)
   */
  defaultExposure: PublicOperationExposure;
}
