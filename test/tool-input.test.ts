import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseToolInput, ToolInputError } from '../src/validation.js';

describe('parseToolInput', () => {
  const schema = z.object({ max_transactions: z.number().int().positive().max(25).default(10) });

  it('returns parsed defaults for empty arguments', () => {
    expect(parseToolInput(schema, undefined)).toEqual({ max_transactions: 10 });
  });

  it('names the offending field instead of a generic failure', () => {
    expect(() => parseToolInput(schema, { max_transactions: 30 })).toThrow(ToolInputError);
    expect(() => parseToolInput(schema, { max_transactions: 30 })).toThrow(/Invalid input\. max_transactions: /);
  });
});
