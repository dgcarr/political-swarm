export const normalizedNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

export const formattedMoney = (value: unknown): string => `$${normalizedNumber(value).toFixed(4)}`;

export const pluralizedCount = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;
