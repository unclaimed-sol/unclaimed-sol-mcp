import { describe, it, expect } from 'vitest';
import { formatSol, formatSolFromLamports } from '../src/formatter.js';

describe('formatSol', () => {
  it('returns "no claimable SOL" for zero', () => {
    expect(formatSol(0)).toBe('no claimable SOL');
  });

  it('returns "no claimable SOL" for negative values', () => {
    expect(formatSol(-1)).toBe('no claimable SOL');
    expect(formatSol(-0.001)).toBe('no claimable SOL');
  });

  it('formats values >= 1 SOL with 2 decimal places', () => {
    expect(formatSol(1)).toBe('1.00 SOL');
    expect(formatSol(1.5)).toBe('1.50 SOL');
    expect(formatSol(123.456)).toBe('123.46 SOL');
  });

  it('formats values < 1 SOL with 4 decimal places', () => {
    expect(formatSol(0.5)).toBe('0.5000 SOL');
    expect(formatSol(0.0001)).toBe('0.0001 SOL');
    expect(formatSol(0.12345)).toBe('0.1235 SOL');
  });

  it('boundary: just below 1 SOL uses 4 decimal places', () => {
    expect(formatSol(0.9999)).toBe('0.9999 SOL');
  });
});

describe('formatSolFromLamports', () => {
  it('converts lamports to SOL and formats', () => {
    expect(formatSolFromLamports(1_000_000_000)).toBe('1.00 SOL');
  });

  it('handles zero lamports', () => {
    expect(formatSolFromLamports(0)).toBe('no claimable SOL');
  });

  it('handles sub-SOL lamport amounts', () => {
    expect(formatSolFromLamports(500_000_000)).toBe('0.5000 SOL');
  });

  it('handles large lamport amounts', () => {
    expect(formatSolFromLamports(10_500_000_000)).toBe('10.50 SOL');
  });
});
