import { createJiti } from "jiti";
import { isAbsolute, resolve } from "node:path";
import type { AnyStateMachine } from "xstate";

export interface LoadedMachine {
  machine: AnyStateMachine;
  file: string;
  exportName: string;
}

/** Parse a `<file>#<export>` spec (export defaults to `default`). */
export function parseSpec(spec: string): { file: string; exportName: string } {
  const hashIdx = spec.lastIndexOf("#");
  if (hashIdx === -1) return { file: spec, exportName: "default" };
  return { file: spec.slice(0, hashIdx), exportName: spec.slice(hashIdx + 1) || "default" };
}

function isStateMachine(value: unknown): value is AnyStateMachine {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { resolveState?: unknown }).resolveState === "function" &&
    (value as { root?: unknown }).root !== undefined
  );
}

/**
 * Load a plain XState machine from a `.ts` or `.js` file via jiti, so authors
 * point at their source directly with no build step. Xanthe never wraps the
 * machine; it loads what the author exported as-is.
 */
export async function loadMachineFromFile(file: string, exportName = "default"): Promise<LoadedMachine> {
  const abs = isAbsolute(file) ? file : resolve(process.cwd(), file);
  const jiti = createJiti(import.meta.url);
  const mod = (await jiti.import(abs)) as Record<string, unknown>;

  const fromDefault = (mod.default as Record<string, unknown> | undefined)?.[exportName];
  const candidate = mod[exportName] ?? fromDefault ?? (exportName === "default" ? mod.default : undefined);

  if (candidate === undefined) {
    const names =
      Object.keys(mod)
        .filter((k) => k !== "default")
        .join(", ") || "(none)";
    throw new Error(`export '${exportName}' not found in ${abs}. Available exports: ${names}`);
  }
  if (!isStateMachine(candidate)) {
    throw new Error(
      `export '${exportName}' in ${abs} is not an XState v5 machine (expected setup().createMachine(...)).`,
    );
  }
  return { machine: candidate, file: abs, exportName };
}

export async function loadMachineFromSpec(spec: string): Promise<LoadedMachine> {
  const { file, exportName } = parseSpec(spec);
  return loadMachineFromFile(file, exportName);
}
