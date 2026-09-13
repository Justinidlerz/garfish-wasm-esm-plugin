import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { compileGarfishModule } from "../../src/compiler";
import type { WasmInitInput } from "../../src/wasm";

const workloads = [
  { id: "small", rows: 128, functions: 8, rounds: 8 },
  { id: "medium", rows: 1024, functions: 64, rounds: 16 },
  { id: "large", rows: 8192, functions: 256, rounds: 32 },
];
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export function browserBenchmarkFixtures(wasm: WasmInitInput): Plugin {
  return {
    name: "browser-execution-benchmark-fixtures",
    apply: "build",
    async generateBundle() {
      const fixtures = [];
      for (const workload of workloads) {
        const { id, rows: count, functions, rounds } = workload;
        const rows = Array.from({ length: count }, (_, i) => ({
          id: i,
          name: `Product ${i + 1}`,
          value: (i * 7919 + 17) % 10000,
          group: i % 16,
        }));
        const base = rows.reduce((sum, row) => sum + row.value + row.group, 0);
        const roundOffsets = Array.from(
          { length: rounds },
          (_, r) => r % 8
        ).reduce((sum, value) => sum + value, 0);
        const source = `
const startedAt = performance.now();
globalThis.__moduleBenchmarkExecutions = (globalThis.__moduleBenchmarkExecutions || 0) + 1;
const rows = ${JSON.stringify(rows)};
const groups = new Map();
for (const row of rows) {
  const group = groups.get(row.group) || [];
  group.push(row);
  groups.set(row.group, group);
}
export let revision = 0;
export function bump() { revision++; }
export function run(rounds) {
  let total = 0;
  for (let round = 0; round < rounds; round++) {
    for (const row of rows) total += row.value + row.group + (round % 8);
  }
  return total;
}
${Array.from(
  { length: functions },
  (_, i) =>
    `export function select${i}() { return rows[${
      i % count
    }].value + revision; }`
).join("\n")}
export const checksum = run(${rounds});
export const rowCount = rows.length;
export const groupCount = groups.size;
export default { checksum, rowCount, groupCount };
export const bodyMs = performance.now() - startedAt;
`;
        const artifact = await compileGarfishModule(source, `${id}.js`, {
          wasm,
        });
        for (const [mode, code] of [
          ["native", source],
          ["precompiled", artifact],
        ]) {
          this.emitFile({
            type: "asset",
            fileName: `fixtures/${mode}/${id}.js`,
            source: code,
          });
        }
        fixtures.push({
          ...workload,
          sourceHash: digest(source),
          artifactHash: digest(artifact),
          nativeBytes: Buffer.byteLength(source),
          precompiledBytes: Buffer.byteLength(artifact),
          expectedChecksum: base * rounds + count * roundOffsets,
          expectedSingleRound: base,
          expectedFirst: rows[0].value,
          expectedGroups: new Set(rows.map((row) => row.group)).size,
          expectedExports: functions + 8,
        });
      }
      const packageJson = JSON.parse(
        readFileSync(new URL("../../package.json", import.meta.url), "utf8")
      );
      const runtimeHash = digest(
        ["runtime.ts", "module.ts", "compiled-module.ts"]
          .map((name) =>
            readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8")
          )
          .join("\n")
      );
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: JSON.stringify(
          {
            schemaVersion: 1,
            packageVersion: packageJson.version,
            runtimeHash,
            buildId: digest(
              JSON.stringify({
                fixtures,
                runtimeHash,
                version: packageJson.version,
              })
            ),
            fixtures,
          },
          null,
          2
        ),
      });
    },
  };
}
