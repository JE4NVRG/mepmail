/** Estimativa em centavos: mesma unidade de 1.000/roundup do contrato provisionado. */
export function estimateOverageCents(over: number, overageCentsPer1k: number): number {
  return Math.ceil(Math.max(0, over) / 1000) * overageCentsPer1k;
}
