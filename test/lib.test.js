import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildOptimizationSuggestions,
  computeDelta,
  computeUsagePercent,
  formatBytes,
  parseBool,
  resolveWasmPath,
} from "../src/lib.js";

test("parseBool handles common truthy/falsy values", () => {
  assert.equal(parseBool("true"), true);
  assert.equal(parseBool("1"), true);
  assert.equal(parseBool("yes"), true);
  assert.equal(parseBool("false", true), false);
  assert.equal(parseBool("0", true), false);
  assert.equal(parseBool("no", true), false);
  assert.equal(parseBool("unexpected", true), true);
});

test("computeUsagePercent and computeDelta work as expected", () => {
  assert.equal(computeUsagePercent(512, 1024), 50);
  const delta = computeDelta(1200, 1000);
  assert.equal(delta.deltaBytes, 200);
  assert.equal(delta.deltaPercent, 20);
});

test("formatBytes gives human readable output", () => {
  assert.equal(formatBytes(100), "100 B");
  assert.equal(formatBytes(1024), "1.00 KiB");
  assert.equal(formatBytes(1048576), "1.00 MiB");
});

test("resolveWasmPath prefers target/wasm32-unknown-unknown/release", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "near-size-test-"));
  try {
    const releaseDir = path.join(tempRoot, "target", "wasm32-unknown-unknown", "release");
    await fs.mkdir(releaseDir, { recursive: true });
    const wasmA = path.join(releaseDir, "a.wasm");
    const wasmB = path.join(releaseDir, "b.wasm");
    await fs.writeFile(wasmA, Buffer.alloc(256));
    await fs.writeFile(wasmB, Buffer.alloc(512));

    const chosen = await resolveWasmPath(tempRoot, "");
    assert.equal(chosen, wasmB);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("resolveWasmPath uses explicit path and validates it exists", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "near-size-test-"));
  try {
    const wasmPath = path.join(tempRoot, "contract.wasm");
    await fs.writeFile(wasmPath, Buffer.alloc(128));
    const chosen = await resolveWasmPath(tempRoot, "contract.wasm");
    assert.equal(chosen, wasmPath);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("buildOptimizationSuggestions returns critical guidance over limit", () => {
  const list = buildOptimizationSuggestions({
    usagePercent: 120,
    warningThresholdPct: 85,
    overLimit: true,
    deltaBytes: 100,
  });
  assert.ok(list.length >= 3);
  assert.ok(list.some((x) => x.includes("lto")));
});
