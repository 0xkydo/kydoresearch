import { statePaths } from "./state.ts";
import { atomicWriteJson, readJsonIfExists } from "./util.ts";

export const MAX_OPERATOR_STEERING_CHARS = 4_000;

export interface OperatorSteeringSnapshot {
  text: string;
  updatedAt: string;
}

interface OperatorSteeringStateV1 {
  version: 1;
  current: OperatorSteeringSnapshot | null;
}

/** Read the operator's current search direction, if one is active. */
export function loadOperatorSteering(
  stateDir: string,
): OperatorSteeringSnapshot | null {
  const value = readJsonIfExists<unknown>(statePaths(stateDir).operatorSteering);
  if (value === null) return null;
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("operator steering must be a version-1 object");
  }
  if (value.current === null) return null;
  if (!isRecord(value.current)) {
    throw new Error("operator steering current value must be an object or null");
  }
  const text = normalizedSteeringText(value.current.text);
  if (typeof value.current.updatedAt !== "string" || value.current.updatedAt.trim() === "") {
    throw new Error("operator steering updatedAt must be a non-empty string");
  }
  return { text, updatedAt: value.current.updatedAt };
}

/** Atomically replace the direction used by future Professor proposal tasks. */
export function setOperatorSteering(
  stateDir: string,
  text: string,
  updatedAt = new Date().toISOString(),
): OperatorSteeringSnapshot {
  const current = {
    text: normalizedSteeringText(text),
    updatedAt,
  };
  const state: OperatorSteeringStateV1 = { version: 1, current };
  atomicWriteJson(statePaths(stateDir).operatorSteering, state);
  return current;
}

/** Clear future steering without mutating already-materialized proposal tasks. */
export function clearOperatorSteering(
  stateDir: string,
): void {
  const state: OperatorSteeringStateV1 = { version: 1, current: null };
  atomicWriteJson(statePaths(stateDir).operatorSteering, state);
}

function normalizedSteeringText(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("operator steering text must not be empty");
  }
  const text = value.replace(/\r\n/g, "\n").trim();
  if (text.length > MAX_OPERATOR_STEERING_CHARS) {
    throw new Error(
      `operator steering text exceeds ${MAX_OPERATOR_STEERING_CHARS} characters`,
    );
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
