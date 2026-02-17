const LAMPORTS_PER_SOL = 1_000_000_000;

/** Format SOL for display. >= 1 SOL: 2dp. < 1 SOL: 4dp. 0: "no claimable SOL" */
export function formatSol(sol: number): string {
  if (sol <= 0) return 'no claimable SOL';
  if (sol >= 1) return `${sol.toFixed(2)} SOL`;
  return `${sol.toFixed(4)} SOL`;
}

export function formatSolFromLamports(lamports: number): string {
  return formatSol(lamports / LAMPORTS_PER_SOL);
}
