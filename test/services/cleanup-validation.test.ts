import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { inspectCleanupTargets } from '../../src/services/cleanup-validation.js';
import { BPF_LOADER_UPGRADEABLE } from '../../src/constants.js';
import { deriveAta, SPL_TOKEN_PROGRAM_ID } from '../../src/services/transaction.js';
const wallet=Keypair.generate().publicKey, mint=Keypair.generate().publicKey;
const token={pubKey:deriveAta(wallet,mint).toBase58(),mintKey:mint.toBase58(),programOwnerId:SPL_TOKEN_PROGRAM_ID.toBase58(),amountUi:0,isFrozen:false,lamports:1};
function account() {
  const data=Buffer.alloc(165); mint.toBuffer().copy(data); wallet.toBuffer().copy(data,32); data[108]=1;
  return {data,owner:SPL_TOKEN_PROGRAM_ID,lamports:1,executable:false,rentEpoch:0};
}
describe('cleanup RPC gate',()=>{
  it.each(['missing','program','mint','owner','state','close'])('skips an invalid %s target without losing the valid target',async kind=>{
    const bad=account(), target={...token,pubKey:token.pubKey};
    if(kind==='program') bad.owner=Keypair.generate().publicKey;
    if(kind==='mint') bad.data.fill(0,0,32);
    if(kind==='owner') bad.data.fill(0,32,64);
    if(kind==='state') bad.data[108]=2;
    if(kind==='close'){bad.data.writeUInt32LE(1,129);bad.data.fill(0,133,165);}
    const rpc={getMultipleAccountsInfo:vi.fn(async()=>[kind==='missing'?null:bad,account()])};
    const result=await inspectCleanupTargets(rpc,wallet,[target,token],[]);
    expect(result.tokens).toEqual([token]); expect(result.skipped).toBe(1);
  });
  it('accepts an otherwise eligible noncanonical empty token account',async()=>{
    const target={...token,pubKey:Keypair.generate().publicKey.toBase58()};
    const rpc={getMultipleAccountsInfo:vi.fn(async()=>[account()])};
    expect(await inspectCleanupTargets(rpc,wallet,[target],[])).toEqual({tokens:[target],buffers:[],skipped:0});
  });
  it.each(['owner','authority','state'])('skips buffers with invalid %s',async kind=>{
    const data=Buffer.alloc(37); data.writeUInt32LE(kind==='state'?0:1); data[4]=1;
    (kind==='authority'?Keypair.generate().publicKey:wallet).toBuffer().copy(data,5);
    const rpc={getMultipleAccountsInfo:vi.fn(async()=>[{...account(),data,owner:kind==='owner'?SPL_TOKEN_PROGRAM_ID:new PublicKey(BPF_LOADER_UPGRADEABLE)}])};
    expect((await inspectCleanupTargets(rpc,wallet,[],[{pubkey:token.pubKey,lamports:1}])).skipped).toBe(1);
  });
  it('reads every target in chunks of 100, with no truncation',async()=>{
    const rpc={getMultipleAccountsInfo:vi.fn(async(keys:PublicKey[])=>keys.map(()=>null))};
    const targets=Array.from({length:256},()=>({...token,pubKey:Keypair.generate().publicKey.toBase58()}));
    const buffers=targets.map(t=>({pubkey:t.pubKey,lamports:1}));
    const result=await inspectCleanupTargets(rpc,wallet,targets,buffers);
    expect(rpc.getMultipleAccountsInfo.mock.calls.map(([keys])=>keys.length)).toEqual([100,100,100,100,100,12]);
    expect(result.skipped).toBe(512);
  });
});
