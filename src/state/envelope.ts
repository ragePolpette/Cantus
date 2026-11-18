import type { ProjectSnapshot } from "./state.js";

export type SnapshotKind = "blocks" | "api" | "callers" | "diagnostics";

/** Shared CLI/MCP representation. Restart pagination when the fingerprint changes. */
export function snapshotPage(snapshot: ProjectSnapshot, kind: SnapshotKind = "blocks", offset = 0, limit = 25) {
  const analysis = snapshot.analysis;
  const collection = { blocks: analysis.blocks, api: analysis.catalog, callers: analysis.callSites, diagnostics: analysis.diagnostics };
  if (!Object.hasOwn(collection, kind) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Invalid snapshot page. Choose blocks, api, callers or diagnostics, offset >= 0 and limit 1..100.");
  }
  const rows = collection[kind];
  const items: unknown[] = [];
  let remaining = 24_000;
  let omitted = 0;
  for (const row of rows.slice(offset, offset + limit)) {
    const size = JSON.stringify(row).length;
    if (size > 24_000) {
      items.push({ omitted: true, index: offset + items.length, reason: "Item exceeds response size limit." });
      omitted++;
    } else {
      if (size > remaining) break;
      items.push(row);
      remaining -= size;
    }
  }
  const next = offset + items.length;
  const errors = analysis.diagnostics.filter(d => d.level === "error").length;
  const warnings = analysis.diagnostics.filter(d => d.level === "warning").length;
  return {
    schemaVersion: 1, kind, items,
    analysis: {
      analyzedAt: snapshot.analyzedAt, fingerprint: snapshot.fingerprint, position: snapshot.position,
      coverage: errors || warnings ? "partial" : "no-warnings-or-errors",
      confidence: "Static analysis. See diagnostics and each call site's match.",
    },
    page: { offset, limit, total: rows.length, ...(next < rows.length ? { nextOffset: next } : {}), omitted },
    diagnostics: { errors, warnings, total: analysis.diagnostics.length },
  };
}
