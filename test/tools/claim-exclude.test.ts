import { describe, it, expect, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { handleClaim, getClaimToolDefinition } from '../../src/tools/claim.js';
import { TransactionBuilder } from '../../src/services/transaction.js';
import type { Config } from '../../src/config.js';

function setup(positive = false) {
  const keypair = Keypair.generate();
  const token = { pubKey: Keypair.generate().publicKey.toBase58(), mintKey: Keypair.generate().publicKey.toBase58(), amountUi: positive ? 1 : 0, amountBaseUnits: positive ? '10' : '0', lamports: 2_039_280, isFrozen: false, symbol: 'TEST', programOwnerId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };
  const buffer = { pubkey: Keypair.generate().publicKey.toBase58(), lamports: 2_000_000, authority: keypair.publicKey.toBase58(), dataLength: 37, dataSha256: 'a'.repeat(64) };
  const config: Config = { apiUrl: 'https://unclaimedsol.com', apiKey: null, keypair, rpcUrl: 'https://api.mainnet-beta.solana.com', priorityFee: 1000, claimEnabled: true };
  const scanner = { getClaimableTokens: vi.fn(async () => ({ tokens: [token] })), getClaimableBuffers: vi.fn(async () => ({ buffers: [buffer] })), getClaimableStakes: vi.fn(async () => ({count:0,estimatedSol:0})) };
  const signer = { inspectCleanup: vi.fn(async (_wallet, tokens, buffers) => ({ tokens: tokens.map(t=>({...t})), buffers: buffers.map(b=>({...b})) })), getBalance: vi.fn().mockResolvedValue(1_000_000_000), signAndSendBatch: vi.fn(async () => [{status:'confirmed',signature:'test-signature'}]) };
  const run = (args: object) => handleClaim(args, config, scanner as any, new TransactionBuilder(config), signer as any);
  return { run, scanner, signer, token, buffer };
}
describe('cleanup previews', () => {
  it('returns a preview without an execution token or approval instructions', async () => {
    const { run, scanner, signer } = setup();
    const result = await run({});
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('Preview only');
    expect(result.content[0].text).not.toMatch(/Execution token:|required_.*approvals|Echo these/);
    expect(scanner.getClaimableBuffers).not.toHaveBeenCalled();
    expect(signer.signAndSendBatch).not.toHaveBeenCalled();
  });
  it('previews explicit positive-token and buffer selections', async () => {
    const { run, token, buffer } = setup(true);
    const result = await run({token_accounts:[token.pubKey],buffer_accounts:[buffer.pubkey]});
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('1 token accounts and 1 buffer accounts');
    expect(result.content[0].text).toContain('base units: 10');
  });
  it('reports skipped automatic candidates alongside eligible targets', async () => {
    const {run,signer,token}=setup();
    signer.inspectCleanup.mockResolvedValueOnce({tokens:[token],buffers:[],skippedTokenCount:2} as any);
    const result = await run({});
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('Skipped 2 ineligible automatic');
  });
  it('reports skipped candidates even when none remain eligible', async () => {
    const {run,signer}=setup();
    signer.inspectCleanup.mockResolvedValueOnce({tokens:[],buffers:[],skippedTokenCount:1} as any);
    expect((await run({})).content[0].text).toContain('Skipped 1 ineligible automatic');
  });
  it('does not automatically select positive tokens', async () => {
    expect((await setup(true).run({})).isError).toBe(true);
  });
  it('honors symbol exclusions during preview', async () => {
    const { run } = setup();
    expect((await run({exclude:['test']})).content[0].text).toContain('No token or buffer accounts');
  });
  it.each([{}, {execution_token:'old-token'}, {approved_token_accounts:[]}])('rejects execution before any RPC or backend work: %j', async extra => {
    const { run, scanner, signer } = setup();
    const result = await run({dry_run:false,...extra});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('CHECKED_CLEANUP_UNAVAILABLE');
    expect(scanner.getClaimableTokens).not.toHaveBeenCalled();
    expect(signer.inspectCleanup).not.toHaveBeenCalled();
    expect(signer.signAndSendBatch).not.toHaveBeenCalled();
  });
  it('advertises the supported read-only interface', () => {
    const tool = getClaimToolDefinition();
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.inputSchema.properties).not.toHaveProperty('execution_token');
    expect(tool.inputSchema.properties).not.toHaveProperty('approved_token_accounts');
    expect(tool.inputSchema.properties).not.toHaveProperty('approved_buffer_accounts');
  });
});
