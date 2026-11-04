const STEP = 1024;

/** A position strictly between two neighbours, or null when float precision has run out. */
export function positionBetween(prev: number | null, next: number | null): number | null {
  if (prev === null) return next === null ? STEP : next - STEP;
  if (next === null) return prev + STEP;
  const middle = prev + (next - prev) / 2;
  return middle === prev || middle === next ? null : middle;
}

export function renumber(count: number): number[] {
  return Array.from({ length: count }, (_, index) => STEP * (index + 1));
}
