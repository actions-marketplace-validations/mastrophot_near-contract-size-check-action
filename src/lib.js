import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_LIMIT_BYTES = 4 * 1024 * 1024;
const DEFAULT_WARNING_THRESHOLD_PCT = 85;

export function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

export function parsePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export function parsePositiveFloat(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export function parseConfig(inputs) {
  return {
    buildCommand: inputs.buildCommand,
    workingDirectory: inputs.workingDirectory || ".",
    wasmPathInput: inputs.wasmPath || "",
    sizeLimitBytes: parsePositiveInt(inputs.sizeLimitBytes, DEFAULT_LIMIT_BYTES),
    warningThresholdPct: parsePositiveFloat(inputs.warningThresholdPct, DEFAULT_WARNING_THRESHOLD_PCT),
    failIfOverLimit: parseBool(inputs.failIfOverLimit, true),
    failOnWarning: parseBool(inputs.failOnWarning, false),
    enableCompare: parseBool(inputs.enableCompare, true),
    compareRef: inputs.compareRef || "HEAD~1",
    baselineBuildCommand: inputs.baselineBuildCommand || inputs.buildCommand,
    baselineWasmPathInput: inputs.baselineWasmPath || inputs.wasmPath || "",
    writeSummary: parseBool(inputs.writeSummary, true),
  };
}

export function computeUsagePercent(sizeBytes, limitBytes) {
  if (!limitBytes || limitBytes <= 0) return 0;
  return (sizeBytes / limitBytes) * 100;
}

export function computeDelta(currentBytes, baselineBytes) {
  if (baselineBytes === null || baselineBytes === undefined || baselineBytes <= 0) {
    return { deltaBytes: null, deltaPercent: null };
  }
  const deltaBytes = currentBytes - baselineBytes;
  const deltaPercent = (deltaBytes / baselineBytes) * 100;
  return { deltaBytes, deltaPercent };
}

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "n/a";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(2)} ${units[i]}`;
}

export function formatPct(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return `${value.toFixed(2)}%`;
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function resolveWasmPath(baseDir, explicitPath) {
  if (explicitPath && explicitPath.trim() !== "") {
    const resolved = path.isAbsolute(explicitPath)
      ? explicitPath
      : path.resolve(baseDir, explicitPath);
    if (!(await fileExists(resolved))) {
      throw new Error(`WASM file not found at explicit path: ${resolved}`);
    }
    return resolved;
  }

  const preferred = path.resolve(baseDir, "target/wasm32-unknown-unknown/release");
  const preferredCandidates = await findWasmCandidates(preferred, 3);
  if (preferredCandidates.length > 0) {
    return pickBestWasm(preferredCandidates).file;
  }

  const fallbackCandidates = await findWasmCandidates(baseDir, 6);
  if (fallbackCandidates.length === 0) {
    throw new Error(
      "No .wasm file found. Set 'wasm-path' explicitly or ensure build outputs target/wasm32-unknown-unknown/release/*.wasm"
    );
  }
  return pickBestWasm(fallbackCandidates).file;
}

function shouldSkipDir(name) {
  return [".git", "node_modules", "dist", "coverage", ".next", ".turbo"].includes(name);
}

export async function findWasmCandidates(rootDir, maxDepth) {
  const candidates = [];

  async function walk(currentDir, depth) {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".wasm")) continue;
      try {
        const stat = await fs.stat(full);
        candidates.push({ file: full, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // Ignore unreadable entries.
      }
    }
  }

  await walk(rootDir, 0);
  return candidates;
}

export function pickBestWasm(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("No WASM candidates available");
  }
  return [...candidates].sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    return b.mtimeMs - a.mtimeMs;
  })[0];
}

export function buildOptimizationSuggestions({
  usagePercent,
  warningThresholdPct,
  overLimit,
  deltaBytes,
}) {
  const out = [];

  if (overLimit) {
    out.push("Enable size-focused Rust profile: `lto = true`, `codegen-units = 1`, `opt-level = 'z'`, `panic = 'abort'`.");
    out.push("Strip symbols during release: `RUSTFLAGS='-C link-arg=-s'` and avoid debug info in release profile.");
    out.push("Audit dependencies and disable default features you do not use in contract runtime.");
    out.push("Move heavy off-chain logic out of contract methods and reduce serialized payload sizes.");
    out.push("Split large contracts into smaller modules/contracts when architecture allows.");
    return out;
  }

  if (usagePercent >= warningThresholdPct) {
    out.push("You are close to NEAR size limit; consider enabling `lto = true` and `opt-level = 'z'` for release.");
    out.push("Review transitive dependencies and remove unused crates/features.");
    out.push("Use smaller data structures and avoid embedding large constants/blobs in contract binary.");
  }

  if (deltaBytes !== null && deltaBytes > 0) {
    out.push("Current build is larger than baseline; inspect recent commits for newly added dependencies or generated code.");
  }

  if (out.length === 0) {
    out.push("No optimization needed right now. Keep tracking size drift in CI to prevent regressions.");
  }

  return out;
}

export function asMarkdownList(items) {
  return items.map((s) => `- ${s}`).join("\n");
}
