import { readFileSync } from "node:fs";
import { summarize } from "./summary.mjs";

if (!process.argv[2])
  throw new Error("Usage: node benchmarks/browser/summarize.mjs results.json");
const suite = JSON.parse(readFileSync(process.argv[2], "utf8"));
console.log(
  JSON.stringify(
    {
      buildId: suite.manifest.buildId,
      packageVersion: suite.manifest.packageVersion,
      condition: suite.config.condition,
      userAgent: suite.samples[0]?.userAgent,
      report: summarize(suite),
    },
    null,
    2
  )
);
