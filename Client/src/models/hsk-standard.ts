// The HSK standard an HSK lesson follows. Sent by value (2 or 3), not by ordinal; keep in step with
// HskStandard in Server/internal/csvgen/options.go.
export enum HskStandard {
  V2 = 2,
  V3 = 3
}

// The highest level of each standard: HSK 2.0 stops at 6, HSK 3.0 goes to 9.
export function hskMaxLevel(standard: HskStandard | null): number {
  return standard === HskStandard.V3 ? 9 : 6;
}
