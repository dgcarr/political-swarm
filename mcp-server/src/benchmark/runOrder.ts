export function rotatedStrategyOrder<T>(
  strategies: readonly T[],
  trialIndex: number,
): T[] {
  if (strategies.length === 0) return [];
  const shift = ((trialIndex % strategies.length) + strategies.length) % strategies.length;
  if (shift === 0) return [...strategies];
  return [...strategies.slice(shift), ...strategies.slice(0, shift)];
}

export function describeRotation(
  strategies: readonly string[],
  trialIndex: number,
): string {
  const rotated = rotatedStrategyOrder(strategies, trialIndex);
  return `trial ${trialIndex}: ${rotated.join(',')}`;
}
