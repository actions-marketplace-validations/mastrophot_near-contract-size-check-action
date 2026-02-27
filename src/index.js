import * as core from "@actions/core";
import * as exec from "@actions/exec";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  asMarkdownList,
  buildOptimizationSuggestions,
  computeDelta,
  computeUsagePercent,
  formatBytes,
  formatPct,
  parseConfig,
  resolveWasmPath,
} from "./lib.js";

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function runShell(command, { cwd, allowFailure = false } = {}) {
  let stdout = "";
  let stderr = "";

  const code = await exec.exec("bash", ["-lc", command], {
    cwd,
    ignoreReturnCode: true,
    listeners: {
      stdout: (data) => {
        stdout += data.toString();
      },
      stderr: (data) => {
        stderr += data.toString();
      },
    },
  });

  if (code !== 0 && !allowFailure) {
    const err = stderr.trim() || stdout.trim() || `Command failed: ${command}`;
    throw new Error(err);
  }

  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

function emitOutputs({
  wasmPath,
  currentSizeBytes,
  sizeLimitBytes,
  usagePercent,
  warningTriggered,
  overLimit,
  baselineWasmPath,
  baselineSizeBytes,
  deltaBytes,
  deltaPercent,
  suggestions,
}) {
  core.setOutput("wasm-path", wasmPath);
  core.setOutput("current-size-bytes", String(currentSizeBytes));
  core.setOutput("size-limit-bytes", String(sizeLimitBytes));
  core.setOutput("usage-percent", usagePercent.toFixed(4));
  core.setOutput("warning-triggered", String(warningTriggered));
  core.setOutput("over-limit", String(overLimit));
  core.setOutput("baseline-wasm-path", baselineWasmPath ?? "");
  core.setOutput("baseline-size-bytes", baselineSizeBytes == null ? "" : String(baselineSizeBytes));
  core.setOutput("delta-bytes", deltaBytes == null ? "" : String(deltaBytes));
  core.setOutput("delta-percent", deltaPercent == null ? "" : deltaPercent.toFixed(4));
  core.setOutput("optimization-suggestions", asMarkdownList(suggestions));
}

async function writeSummary({
  wasmPath,
  currentSizeBytes,
  sizeLimitBytes,
  usagePercent,
  warningTriggered,
  overLimit,
  baselineWasmPath,
  baselineSizeBytes,
  deltaBytes,
  deltaPercent,
  suggestions,
}) {
  await core.summary
    .addHeading("NEAR Contract Size Check")
    .addTable([
      [
        { data: "Metric", header: true },
        { data: "Value", header: true },
      ],
      ["Current WASM", `\`${wasmPath}\``],
      ["Current size", `${formatBytes(currentSizeBytes)} (${currentSizeBytes} bytes)`],
      ["Size limit", `${formatBytes(sizeLimitBytes)} (${sizeLimitBytes} bytes)`],
      ["Usage", formatPct(usagePercent)],
      ["Warning threshold reached", String(warningTriggered)],
      ["Over limit", String(overLimit)],
      ["Baseline WASM", baselineWasmPath ? `\`${baselineWasmPath}\`` : "n/a"],
      ["Baseline size", baselineSizeBytes == null ? "n/a" : `${formatBytes(baselineSizeBytes)} (${baselineSizeBytes} bytes)`],
      ["Delta", deltaBytes == null ? "n/a" : `${deltaBytes >= 0 ? "+" : ""}${formatBytes(Math.abs(deltaBytes))} (${deltaBytes} bytes)`],
      ["Delta %", formatPct(deltaPercent)],
    ])
    .addRaw("\n")
    .addHeading("Optimization Suggestions", 2)
    .addRaw(asMarkdownList(suggestions))
    .write();
}

async function getFileSize(filePath) {
  const stat = await fs.stat(filePath);
  return stat.size;
}

async function tryBaselineComparison(config) {
  if (!config.enableCompare) {
    core.info("Baseline comparison is disabled.");
    return { baselineWasmPath: null, baselineSizeBytes: null, deltaBytes: null, deltaPercent: null };
  }

  const repoCheck = await runShell("git rev-parse --is-inside-work-tree", {
    cwd: config.workingDirectory,
    allowFailure: true,
  });

  if (repoCheck.code !== 0) {
    core.warning("Skipping baseline comparison: working-directory is not a git repository.");
    return { baselineWasmPath: null, baselineSizeBytes: null, deltaBytes: null, deltaPercent: null };
  }

  const refCheck = await runShell(`git rev-parse --verify ${shellEscape(config.compareRef)}`, {
    cwd: config.workingDirectory,
    allowFailure: true,
  });

  if (refCheck.code !== 0) {
    core.warning(`Skipping baseline comparison: compare-ref '${config.compareRef}' not found.`);
    return { baselineWasmPath: null, baselineSizeBytes: null, deltaBytes: null, deltaPercent: null };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "near-size-baseline-"));
  let baselineWasmPath = null;
  let baselineSizeBytes = null;

  try {
    core.info(`Preparing baseline worktree from ${config.compareRef}`);
    await runShell(
      `git worktree add --detach ${shellEscape(tempDir)} ${shellEscape(config.compareRef)}`,
      { cwd: config.workingDirectory }
    );

    core.info(`Building baseline contract using: ${config.baselineBuildCommand}`);
    await runShell(config.baselineBuildCommand, { cwd: tempDir });

    baselineWasmPath = await resolveWasmPath(tempDir, config.baselineWasmPathInput);
    baselineSizeBytes = await getFileSize(baselineWasmPath);
  } catch (error) {
    core.warning(`Baseline comparison skipped due to error: ${error.message}`);
  } finally {
    await runShell(`git worktree remove --force ${shellEscape(tempDir)}`, {
      cwd: config.workingDirectory,
      allowFailure: true,
    });
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  return { baselineWasmPath, baselineSizeBytes };
}

async function main() {
  const config = parseConfig({
    buildCommand: core.getInput("build-command", { required: false }),
    workingDirectory: core.getInput("working-directory", { required: false }),
    wasmPath: core.getInput("wasm-path", { required: false }),
    sizeLimitBytes: core.getInput("size-limit-bytes", { required: false }),
    warningThresholdPct: core.getInput("warning-threshold-pct", { required: false }),
    failIfOverLimit: core.getInput("fail-if-over-limit", { required: false }),
    failOnWarning: core.getInput("fail-on-warning", { required: false }),
    enableCompare: core.getInput("enable-compare", { required: false }),
    compareRef: core.getInput("compare-ref", { required: false }),
    baselineBuildCommand: core.getInput("baseline-build-command", { required: false }),
    baselineWasmPath: core.getInput("baseline-wasm-path", { required: false }),
    writeSummary: core.getInput("write-summary", { required: false }),
  });

  config.workingDirectory = path.resolve(config.workingDirectory);

  core.info(`Building contract in ${config.workingDirectory}`);
  core.info(`Build command: ${config.buildCommand}`);
  await runShell(config.buildCommand, { cwd: config.workingDirectory });

  const wasmPath = await resolveWasmPath(config.workingDirectory, config.wasmPathInput);
  const currentSizeBytes = await getFileSize(wasmPath);
  const usagePercent = computeUsagePercent(currentSizeBytes, config.sizeLimitBytes);
  const warningTriggered = usagePercent >= config.warningThresholdPct;
  const overLimit = currentSizeBytes > config.sizeLimitBytes;

  core.info(`Resolved WASM: ${wasmPath}`);
  core.info(`WASM size: ${currentSizeBytes} bytes (${formatBytes(currentSizeBytes)})`);
  core.info(`Size limit: ${config.sizeLimitBytes} bytes (${formatBytes(config.sizeLimitBytes)})`);
  core.info(`Usage: ${formatPct(usagePercent)}`);

  const baseline = await tryBaselineComparison(config);
  const { deltaBytes, deltaPercent } = computeDelta(currentSizeBytes, baseline.baselineSizeBytes);

  if (baseline.baselineSizeBytes != null) {
    core.info(`Baseline size: ${baseline.baselineSizeBytes} bytes (${formatBytes(baseline.baselineSizeBytes)})`);
    core.info(`Delta: ${deltaBytes} bytes (${formatPct(deltaPercent)})`);
  }

  const suggestions = buildOptimizationSuggestions({
    usagePercent,
    warningThresholdPct: config.warningThresholdPct,
    overLimit,
    deltaBytes,
  });

  if (warningTriggered) {
    core.warning(
      `Contract uses ${formatPct(usagePercent)} of limit (threshold ${config.warningThresholdPct}%).`
    );
  }

  if (overLimit) {
    core.error(
      `Contract is over NEAR size limit by ${currentSizeBytes - config.sizeLimitBytes} bytes.`
    );
  }

  emitOutputs({
    wasmPath,
    currentSizeBytes,
    sizeLimitBytes: config.sizeLimitBytes,
    usagePercent,
    warningTriggered,
    overLimit,
    baselineWasmPath: baseline.baselineWasmPath,
    baselineSizeBytes: baseline.baselineSizeBytes,
    deltaBytes,
    deltaPercent,
    suggestions,
  });

  if (config.writeSummary) {
    await writeSummary({
      wasmPath,
      currentSizeBytes,
      sizeLimitBytes: config.sizeLimitBytes,
      usagePercent,
      warningTriggered,
      overLimit,
      baselineWasmPath: baseline.baselineWasmPath,
      baselineSizeBytes: baseline.baselineSizeBytes,
      deltaBytes,
      deltaPercent,
      suggestions,
    });
  }

  if (overLimit && config.failIfOverLimit) {
    core.setFailed(
      `WASM size (${currentSizeBytes} bytes) exceeds limit (${config.sizeLimitBytes} bytes).`
    );
    return;
  }

  if (warningTriggered && config.failOnWarning) {
    core.setFailed(
      `WASM usage (${formatPct(usagePercent)}) exceeded warning threshold (${config.warningThresholdPct}%).`
    );
  }
}

main().catch((error) => {
  core.setFailed(error.message);
});
