// Money helpers. Unleashed stores prices to 4 decimal places, so we calculate in
// ten-thousandths of a dollar (integers) and round to cents only at the end.

const SCALE = 10_000;

export function toUnits(amount: number): number {
  return Math.round(amount * SCALE);
}

export function fromUnits(units: number): number {
  return units / SCALE;
}

/** Round half away from zero to 2 decimal places. */
export function roundCents(amount: number): number {
  const units = toUnits(amount);
  const cents = Math.sign(units) * Math.round(Math.abs(units) / 100);
  return cents / 100;
}

/** amount × (1 − fraction), in exact units. */
export function applyDiscount(amount: number, fraction: number): number {
  if (!fraction) return amount;
  const units = toUnits(amount);
  const keepPpm = Math.round((1 - fraction) * 1_000_000);
  return fromUnits(Math.round((units * keepPpm) / 1_000_000));
}

export function multiply(amount: number, qty: number): number {
  return fromUnits(Math.round(toUnits(amount) * qty));
}
