import { ComputeBudgetProgram, Transaction } from '@solana/web3.js';
import { PROGRAM_ID } from '../constants.js';

/** Only a standalone close-empty instruction can be omitted as a no-op.
 * Other instructions may have useful effects even if cleanup closes nothing. */
export function closeEmptyTargetCount(transaction: Transaction): number | null {
  const work = transaction.instructions.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId));
  if (work.length !== 1 || work[0].programId.toBase58() !== PROGRAM_ID ||
    work[0].data.length !== 1 || work[0].data[0] !== 2 ||
    work[0].keys.length < 4 || (work[0].keys.length - 4) % 2 !== 0) return null;
  return (work[0].keys.length - 4) / 2;
}

/** A simulation summary is usable only inside a complete, successful program
 * invocation. Track CPI depth so nested programs cannot impersonate the event.
 * A zero-close instruction must have made no CPI, as specified by selector 2. */
export function simulatedCloseCount(logs: string[] | null, targets: number): number | null {
  if (!logs || logs.some(line => /truncated/i.test(line))) return null;
  const stack: string[] = [];
  let invocations = 0;
  let nested = false;
  let count: number | null = null;
  for (const line of logs) {
    const invoke = /^Program (\S+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      if (Number(invoke[2]) !== stack.length + 1) return null;
      if (stack[0] === PROGRAM_ID) nested = true;
      if (invoke[1] === PROGRAM_ID) {
        if (stack.length !== 0 || ++invocations !== 1) return null;
      }
      stack.push(invoke[1]);
      continue;
    }
    const finish = /^Program (\S+) (success|failed:.*)$/.exec(line);
    if (finish) {
      if (finish[2] !== 'success' || stack.pop() !== finish[1]) return null;
      continue;
    }
    if (stack.length !== 1 || stack[0] !== PROGRAM_ID || !line.startsWith('Program log: us:event:close_empty_summary')) continue;
    const summary = /^Program log: us:event:close_empty_summary closed=(\d+) recovered=(\d+) fee=(\d+)$/.exec(line);
    if (!summary || count !== null) return null;
    count = Number(summary[1]);
    const recovered = BigInt(summary[2]), fee = BigInt(summary[3]);
    if (!Number.isSafeInteger(count) || count > targets || fee > recovered ||
      (count === 0 ? recovered !== 0n || fee !== 0n : recovered === 0n)) return null;
  }
  if (stack.length !== 0 || invocations !== 1 || (count === 0 && nested)) return null;
  return count;
}
