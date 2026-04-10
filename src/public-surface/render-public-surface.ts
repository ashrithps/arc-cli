/**
 * Registry-driven renderers for the Arc public README and agent skill file.
 *
 * Consumers:
 *   - `scripts/publish-public.sh` calls this module via a `--write` CLI entry
 *     to replace content between marker pairs in source and public repo files.
 *   - `tests/public-surface-render.test.ts` asserts that the generated markdown
 *     covers the entire operation registry.
 *
 * Generation is deliberately idempotent and hand-content-preserving: each
 * generated block is wrapped with BEGIN/END markers so hand-maintained
 * install / runtime / security notes can coexist unchanged.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PUBLIC_OPERATIONS } from "./operation-registry.js";
import type {
  PublicOperation,
  PublicOperationGroup,
} from "./registry-types.js";

export const README_MARKER_BEGIN = "<!-- BEGIN:ARC_OPERATIONS_README -->";
export const README_MARKER_END = "<!-- END:ARC_OPERATIONS_README -->";
export const SKILL_MARKER_BEGIN = "<!-- BEGIN:ARC_OPERATIONS_SKILL -->";
export const SKILL_MARKER_END = "<!-- END:ARC_OPERATIONS_SKILL -->";

// Canonical group order for rendering. Mirrors the order groups appear in
// `PUBLIC_OPERATIONS`; keeping the array explicit makes the output stable
// even if the registry file is reorganized later.
const GROUP_ORDER: readonly PublicOperationGroup[] = [
  "accounts",
  "transactions",
  "categories",
  "payees",
  "rules",
  "schedules",
  "budgets",
  "query",
];

const GROUP_TITLES: Record<PublicOperationGroup, string> = {
  accounts: "Accounts",
  transactions: "Transactions",
  categories: "Categories",
  payees: "Payees",
  rules: "Rules",
  schedules: "Schedules",
  budgets: "Budgets",
  query: "Query",
};

const GROUP_TAGLINES: Record<PublicOperationGroup, string> = {
  accounts: "Manage on- and off-budget accounts and balances.",
  transactions:
    "Create, update, split, transfer, and batch-process transactions.",
  categories: "Manage category groups and individual categories.",
  payees: "Manage payees, merge duplicates, and look up usage.",
  rules: "Define and maintain auto-categorization and payee-cleanup rules.",
  schedules: "Manage recurring schedules and post them as transactions.",
  budgets:
    "Inspect budget months, set budgeted amounts, and switch between budgets.",
  query: "Read-only reports and ad-hoc Actual queries.",
};

function groupOperations(
  ops: readonly PublicOperation[],
): Map<PublicOperationGroup, PublicOperation[]> {
  const map = new Map<PublicOperationGroup, PublicOperation[]>();
  for (const g of GROUP_ORDER) map.set(g, []);
  for (const op of ops) {
    const list = map.get(op.group);
    if (list) list.push(op);
  }
  // Stable within-group order: default ops first, advanced last, then
  // preserve registry insertion order inside each tier.
  for (const [, list] of map) {
    list.sort((a, b) => {
      if (a.defaultExposure === b.defaultExposure) return 0;
      return a.defaultExposure === "default" ? -1 : 1;
    });
  }
  return map;
}

function formatAliases(op: PublicOperation): string {
  if (!op.aliases || op.aliases.length === 0) return "";
  return ` (alias: ${op.aliases.map((a) => `\`${a}\``).join(", ")})`;
}

function advancedTag(op: PublicOperation): string {
  return op.defaultExposure === "advanced" ? " _(advanced)_" : "";
}

function firstExample(op: PublicOperation): string {
  return op.examples[0] ?? `arc ${op.group} ${op.subcommand}`;
}

// ── README renderer ─────────────────────────────────────────────────────────

export function renderPublicReadmeSections(): string {
  const grouped = groupOperations(PUBLIC_OPERATIONS);
  const lines: string[] = [];
  lines.push(
    "<!-- Generated from src/public-surface/operation-registry.ts. Do not edit by hand. -->",
  );
  lines.push("");
  lines.push(
    "Arc exposes the commands below both as CLI subcommands and as MCP tools (`arc mcp`). Every entry is generated from the single operation registry, so the CLI, MCP, and docs always match.",
  );
  lines.push("");

  for (const group of GROUP_ORDER) {
    const ops = grouped.get(group) ?? [];
    if (ops.length === 0) continue;
    lines.push(`## ${GROUP_TITLES[group]}`);
    lines.push("");
    lines.push(GROUP_TAGLINES[group]);
    lines.push("");
    for (const op of ops) {
      lines.push(
        `- **\`arc ${op.group} ${op.subcommand}\`**${formatAliases(op)} — ${op.description}${advancedTag(op)}`,
      );
      lines.push("");
      lines.push("  ```bash");
      lines.push(`  ${firstExample(op)}`);
      lines.push("  ```");
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ── SKILL renderer ──────────────────────────────────────────────────────────

export function renderPublicSkillSections(): string {
  const grouped = groupOperations(PUBLIC_OPERATIONS);
  const lines: string[] = [];
  lines.push(
    "<!-- Generated from src/public-surface/operation-registry.ts. Do not edit by hand. -->",
  );
  lines.push("");
  lines.push(
    "Arc's data-operation surface is exposed identically through the CLI and through `arc mcp` (stdio MCP server). Every operation below is available as both `arc <group> <subcommand>` on the command line and as an MCP tool named `arc_<group>_<subcommand>`. Prefer the MCP tools from inside agents — argument validation and error messages are structured.",
  );
  lines.push("");
  lines.push(
    "Each entry is tagged with its mode (`read` or `write`) and exposure tier. Tools tagged `(advanced)` are batch, destructive, or global-state operations; treat them as opt-in and double-check inputs before calling.",
  );
  lines.push("");

  for (const group of GROUP_ORDER) {
    const ops = grouped.get(group) ?? [];
    if (ops.length === 0) continue;
    lines.push(`## ${GROUP_TITLES[group]}`);
    lines.push("");
    lines.push(GROUP_TAGLINES[group]);
    lines.push("");
    for (const op of ops) {
      const exposure =
        op.defaultExposure === "advanced" ? " (advanced)" : "";
      lines.push(
        `### \`arc ${op.group} ${op.subcommand}\`${formatAliases(op)}`,
      );
      lines.push("");
      lines.push(
        `- mode: **${op.mode}**${exposure}`,
      );
      lines.push(`- mcp tool: \`${op.mcpTool}\``);
      lines.push(`- ${op.description}`);
      if (op.examples.length > 0) {
        lines.push("");
        lines.push("```bash");
        for (const ex of op.examples) lines.push(ex);
        lines.push("```");
      }
      lines.push("");
    }
  }

  lines.push("## MCP Parity");
  lines.push("");
  lines.push(
    "Running `arc mcp` starts a stdio MCP server that registers one tool per entry above. Tool names follow `arc_<group>_<subcommand>` (hyphens become underscores). The same argument names, defaults, and validation rules apply on both surfaces.",
  );

  return lines.join("\n").trimEnd() + "\n";
}

// ── Marker-replacement helpers ──────────────────────────────────────────────

export function replaceBetweenMarkers(
  source: string,
  begin: string,
  end: string,
  replacement: string,
): string {
  const beginIdx = source.indexOf(begin);
  const endIdx = source.indexOf(end);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error(
      `replaceBetweenMarkers: missing or misordered markers ('${begin}' / '${end}')`,
    );
  }
  const before = source.slice(0, beginIdx + begin.length);
  const after = source.slice(endIdx);
  return `${before}\n${replacement}\n${after}`;
}

export interface WriteTargets {
  readmePath?: string;
  skillPath?: string;
}

export function writeGeneratedSections(targets: WriteTargets): void {
  if (targets.readmePath) {
    const readme = readFileSync(targets.readmePath, "utf8");
    const nextReadme = replaceBetweenMarkers(
      readme,
      README_MARKER_BEGIN,
      README_MARKER_END,
      renderPublicReadmeSections(),
    );
    writeFileSync(targets.readmePath, nextReadme);
  }

  if (targets.skillPath) {
    const skill = readFileSync(targets.skillPath, "utf8");
    const nextSkill = replaceBetweenMarkers(
      skill,
      SKILL_MARKER_BEGIN,
      SKILL_MARKER_END,
      renderPublicSkillSections(),
    );
    writeFileSync(targets.skillPath, nextSkill);
  }
}

// ── CLI entry point ─────────────────────────────────────────────────────────

function parseFlag(argv: string[], flag: string): string | null {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const value = argv[idx + 1];
  if (!value) {
    throw new Error(`${flag} requires a path to the target repo`);
  }
  return value;
}

function main(argv: string[]): void {
  const publicRepo = parseFlag(argv, "--write");
  const sourceRepo = parseFlag(argv, "--write-source");

  if (!publicRepo && !sourceRepo) {
    process.stdout.write(renderPublicReadmeSections());
    process.stdout.write("\n");
    process.stdout.write(renderPublicSkillSections());
    return;
  }

  if (publicRepo) {
    const absRepo = resolve(publicRepo);
    writeGeneratedSections({
      readmePath: resolve(absRepo, "README.md"),
      skillPath: resolve(absRepo, "skill/SKILL.md"),
    });
    process.stdout.write(`Updated public generated sections in ${absRepo}\n`);
  }

  if (sourceRepo) {
    // Only skills/arc.md hosts the generated operations catalog in the source
    // repo; source README.md holds a registry-driven-surface pointer instead.
    const absRepo = resolve(sourceRepo);
    writeGeneratedSections({
      skillPath: resolve(absRepo, "skills/arc.md"),
    });
    process.stdout.write(`Updated source generated sections in ${absRepo}\n`);
  }
}

// Run only when invoked directly (e.g. `tsx src/public-surface/render-public-surface.ts --write /path`).
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const url = new URL(import.meta.url);
    return url.pathname.endsWith(entry) || entry.endsWith("render-public-surface.ts");
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `render-public-surface: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
