export type Mode = "native" | "precompiled";
export interface Fixture {
  id: string;
  rows: number;
  functions: number;
  rounds: number;
  sourceHash: string;
  artifactHash: string;
  nativeBytes: number;
  precompiledBytes: number;
  expectedChecksum: number;
  expectedSingleRound: number;
  expectedFirst: number;
  expectedGroups: number;
  expectedExports: number;
}
export interface Manifest {
  schemaVersion: number;
  packageVersion: string;
  runtimeHash: string;
  buildId: string;
  fixtures: Fixture[];
}
export interface TrialResult {
  mode: Mode;
  fixture: string;
  buildId: string;
  importReadyMs: number;
  importStartedAt: number;
  importEndedAt: number;
  bodyMs: number;
  prepareMs: number;
  checksum: number;
  bytes: number;
  userAgent: string;
  crossOriginIsolated: boolean;
  visibility: string;
  checks: Record<string, boolean>;
  resources: object[];
}
export interface Sample extends TrialResult {
  pair: number;
  warmup: boolean;
}
export interface Suite {
  schemaVersion: 1;
  id: string;
  startedAt: string;
  manifest: Manifest;
  config: {
    fixtures: string[];
    pairs: number;
    warmups: number;
    condition: string;
  };
  samples: Sample[];
  failures: Array<{
    fixture: string;
    mode: Mode;
    pair: number;
    message: string;
  }>;
  completed: boolean;
}
