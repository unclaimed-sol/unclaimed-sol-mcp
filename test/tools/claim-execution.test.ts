import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair, Connection, PublicKey } from '@solana/web3.js';
import { handleClaim, getClaimToolDefinition } from '../../src/tools/claim.js';
import { TransactionBuilder } from '../../src/services/transaction.js';
import { NATIVE_MINT, deriveAta, SPL_TOKEN_PROGRAM_ID } from '../../src/services/transaction.js';
import { BPF_LOADER_UPGRADEABLE } from '../../src/constants.js';
import type { Config } from '../../src/config.js';

afterEach(() => vi.restoreAllMocks());

function setup() {
  const keypair = Keypair.generate();
  const token = {
    pubKey: Keypair.generate().publicKey.toBase58(),
    mintKey: Keypair.generate().publicKey.toBase58(),
    amountUi: 1, lamports: 2_039_280, isFrozen: false, symbol: 'TEST',
    programOwnerId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  };
  token.pubKey = deriveAta(keypair.publicKey, new PublicKey(token.mintKey)).toBase58();
  const buffer = {pubkey:Keypair.generate().publicKey.toBase58(),lamports:2_000_000};
  const config: Config = {apiUrl:'https://unclaimedsol.com',apiKey:null,keypair,rpcUrl:'https://api.mainnet-beta.solana.com',priorityFee:1000,claimEnabled:true};
  const scanner = {
    getClaimableTokens:vi.fn(async()=>({tokens:[token]})),
    getClaimableBuffers:vi.fn(async()=>({buffers:[buffer]})),
    getClaimableStakes:vi.fn(async()=>({count:0,estimatedSol:0})),
  };
  const signer = {
    getBalance:vi.fn().mockResolvedValue(1_000_000_000),
    signAndSendBatch:vi.fn().mockResolvedValue([{status:'confirmed',signature:'confirmed-signature'}]),
  };
  let funded = false;
  const rpc = vi.spyOn(Connection.prototype, 'getMultipleAccountsInfo').mockImplementation(async keys => keys.map(key => {
    const data = Buffer.alloc(key.toBase58() === buffer.pubkey ? 37 : 165);
    if (data.length === 37) { data.writeUInt32LE(1); data[4]=1; keypair.publicKey.toBuffer().copy(data,5); }
    else { new PublicKey(token.mintKey).toBuffer().copy(data); keypair.publicKey.toBuffer().copy(data,32); data[108]=1; data.writeBigUInt64LE(funded ? 1n : 0n,64); if(token.mintKey===NATIVE_MINT.toBase58()) data.writeUInt32LE(1,109); }
    return {data,owner:data.length===37 ? new PublicKey(BPF_LOADER_UPGRADEABLE) : SPL_TOKEN_PROGRAM_ID,lamports:2_039_280,executable:false,rentEpoch:0};
  }));
  const run = (args:object) => handleClaim(args,config,scanner as any,new TransactionBuilder(config),signer as any);
  return {run,scanner,signer,token,rpc,wallet:keypair.publicKey,fund:()=>{funded=true;}};
}
function executionToken(result:Awaited<ReturnType<typeof handleClaim>>) {
  expect(result.isError,result.content[0].text).not.toBe(true);
  const match=result.content[0].text.match(/Execution token: ([a-f0-9]{32})/);
  expect(match).not.toBeNull();
  return match![1];
}

describe('published cleanup execution flow',()=>{
  it('previews backend safe-mode tokens and buffers and then executes',async()=>{
    const {run,scanner,signer}=setup();
    const preview=await run({});
    expect(preview.content[0].text).toContain('1 token accounts and 1 buffer accounts');
    expect(scanner.getClaimableTokens).toHaveBeenCalledWith(expect.any(String));
    expect(scanner.getClaimableBuffers).toHaveBeenCalledOnce();
    const result=await run({dry_run:false,execution_token:executionToken(preview)});
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('confirmed-signature');
    expect(signer.signAndSendBatch).toHaveBeenCalledOnce();
  });
  it('keeps empty wrapped-SOL candidates compatible with the existing flow',async()=>{
    const {run,token,signer,wallet}=setup();
    token.mintKey=NATIVE_MINT.toBase58(); token.amountUi=0; token.pubKey=deriveAta(wallet,NATIVE_MINT).toBase58();
    const execution_token=executionToken(await run({}));
    expect((await run({dry_run:false,execution_token})).isError).not.toBe(true);
    expect(signer.signAndSendBatch).toHaveBeenCalledOnce();
  });
  it('allows only one concurrent execution to take the token',async()=>{
    const {run,signer}=setup();
    const args={dry_run:false,execution_token:executionToken(await run({}))};
    const results=await Promise.all([run(args),run(args)]);
    expect(results.filter(r=>r.isError)).toHaveLength(1);
    expect(signer.signAndSendBatch).toHaveBeenCalledOnce();
  });
  it('preserves submitted signatures when the post-balance RPC fails and rejects replay',async()=>{
    const {run,signer}=setup();
    const args={dry_run:false,execution_token:executionToken(await run({}))};
    signer.getBalance.mockResolvedValueOnce(1_000_000_000).mockRejectedValueOnce(new Error('private endpoint'));
    const result=await run(args);
    expect(result.content[0].text).toContain('confirmed-signature');
    expect(result.content[0].text).toContain('balance RPC failed');
    expect(result.content[0].text).not.toContain('private endpoint');
    expect((await run(args)).isError).toBe(true);
    expect(signer.signAndSendBatch).toHaveBeenCalledOnce();
  });
  it('reports uncertain submissions distinctly and does not permit token reuse',async()=>{
    const {run,signer}=setup();
    const args={dry_run:false,execution_token:executionToken(await run({}))};
    signer.signAndSendBatch.mockResolvedValueOnce([{status:'unknown',signature:'uncertain-signature',error:'SUBMISSION_UNCERTAIN'}]);
    const result=await run(args);
    expect(result.content[0].text).toContain('Submission outcome is uncertain');
    expect(result.content[0].text).toContain('uncertain-signature');
    expect(result.content[0].text).not.toContain('All 1 transactions failed');
    expect((await run(args)).isError).toBe(true);
  });
  it('drops a changed target after taking the token, without adding new targets',async()=>{
    const {run,signer,fund,rpc,token}=setup();
    const execution_token=executionToken(await run({})); fund();
    const result=await run({dry_run:false,execution_token});
    expect(result.content[0].text).toContain('Skipped 1 ineligible');
    expect(rpc.mock.calls.at(-1)![0].map(k=>k.toBase58())).toEqual(rpc.mock.calls[0][0].map(k=>k.toBase58()));
    expect(signer.signAndSendBatch.mock.calls[0][0]).toHaveLength(1); // buffer only
    expect((await run({dry_run:false,execution_token})).isError).toBe(true);
  });
  it('skips funded WSOL while retaining the valid buffer in the preview',async()=>{
    const {run,token,wallet,fund}=setup();
    token.mintKey=NATIVE_MINT.toBase58(); token.pubKey=deriveAta(wallet,NATIVE_MINT).toBase58(); fund();
    const result=await run({});
    expect(result.content[0].text).toContain('0 token accounts and 1 buffer accounts');
    expect(result.content[0].text).toContain('Skipped 1 ineligible');
  });
  it.each(['preview','execution'])('fails rather than skipping on %s RPC failure',async phase=>{
    const {run,rpc,signer}=setup();
    const args=phase==='execution' ? {dry_run:false,execution_token:executionToken(await run({}))} : {};
    rpc.mockRejectedValueOnce(new Error('RPC unavailable'));
    expect((await run(args)).isError).toBe(true);
    expect(signer.signAndSendBatch).not.toHaveBeenCalled();
  });
  it('does not sign without a valid execution token',async()=>{
    const {run,signer}=setup();
    expect((await run({dry_run:false})).isError).toBe(true);
    expect((await run({dry_run:false,execution_token:'invalid'})).isError).toBe(true);
    expect(signer.signAndSendBatch).not.toHaveBeenCalled();
  });
  it('retains destructive execution metadata and the existing input interface',()=>{
    const tool=getClaimToolDefinition();
    expect(tool.annotations.destructiveHint).toBe(true);
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.inputSchema.properties).toHaveProperty('execution_token');
    expect(tool.inputSchema.properties).not.toHaveProperty('token_accounts');
  });
});
