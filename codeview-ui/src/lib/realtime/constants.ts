export const STEP_ORDER = [
  "queued",
  "waiting-capacity",
  "waiting-github-capacity",
  "waiting-rate-limit",
  "workflow-started",
  "github-running",
  "resolving",
  "fetching",
  "parsing",
  "finalizing",
  "storing",
  "indexing",
] as const;

export type ParseStep = (typeof STEP_ORDER)[number];

export const stepLabels = {
  queued: "Queued...",
  "waiting-capacity": "Waiting for parser capacity...",
  "waiting-github-capacity": "Waiting for parser capacity...",
  "waiting-rate-limit": "Waiting for parser capacity...",
  "workflow-started": "Starting parser workflow...",
  "github-running": "Running parser job...",
  resolving: "Resolving metadata...",
  fetching: "Downloading rustdoc...",
  parsing: "Extracting graph...",
  finalizing: "Resolving edges...",
  storing: "Uploading graph...",
  indexing: "Indexing dependencies...",
} as const satisfies { [K in ParseStep]: string };

export const stepPercents = {
  queued: 2,
  "waiting-capacity": 3,
  "waiting-github-capacity": 3,
  "waiting-rate-limit": 3,
  "workflow-started": 5,
  "github-running": 8,
  resolving: 5,
  fetching: 10,
  parsing: 15,
  finalizing: 60,
  storing: 85,
  indexing: 92,
} as const satisfies { [K in ParseStep]: number };

export function isParseStep(step: string): step is ParseStep {
  return Object.hasOwn(stepLabels, step);
}

export function labelForParseStep(step: string): string | undefined {
  return isParseStep(step) ? stepLabels[step] : undefined;
}
