/** Convex's native CLI prints JSON results, but suppresses a successful null. */
export function parseConvexOutput(output: string): unknown {
  const trimmed = output.trim();
  return trimmed === "" ? null : JSON.parse(trimmed) as unknown;
}
