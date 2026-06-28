import { DEFAULT_PHASES } from "../constants";

export type RunPhaseName = (typeof DEFAULT_PHASES)[number];

export type RunPhaseStatus = "pending" | "active" | "complete" | "failed" | "skipped";

export interface RunPhaseState {
  name: RunPhaseName;
  status: RunPhaseStatus;
  startedAt?: string;
  completedAt?: string;
  summary?: string;
}

export function createInitialRunPhases(): RunPhaseState[] {
  return DEFAULT_PHASES.map((name) => ({
    name,
    status: "pending"
  }));
}
