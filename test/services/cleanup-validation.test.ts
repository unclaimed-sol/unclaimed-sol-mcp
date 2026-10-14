import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { inspectCleanupTargets } from '../../src/services/cleanup-validation.js';
import { ATA_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, NATIVE_MINT } from '../../src/services/transaction.js';
import { BPF_LOADER_UPGRADEABLE } from '../../src/constants.js';
function setup() {
  const wallet = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
  const [address] = PublicKey.findProgramAddressSync([wallet.toBuffer(), SPL_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID);
  const data = Buffer.alloc(165); mint.toBuffer().copy(data,0); wallet.toBuffer().copy(data,32); data[108]=1;
  const account = {data,owner:SPL_TOKEN_PROGRAM_ID,lamports:2_039_280,executable:false};
  const token = {pubKey:address.toBase58(),mintKey:mint.toBase58(),programOwnerId:SPL_TOKEN_PROGRAM_ID.toBase58(),amountUi:0,isFrozen:false,lamports:1};
  const connection = {getMultipleAccountsInfo:vi.fn(async()=>[account])};
  return {wallet,data,account,token,connection};
}
describe('cleanup RPC boundary',()=>{
  it('uses the live amount and gross lamports, not the backend amountUi', async()=>{
    const {wallet,data,token,connection}=setup(); data.writeBigUInt64LE(999999999999999999n,64);
    const result=await inspectCleanupTargets(connection as any,wallet,[token],[],[token.pubKey]);
    expect(result.tokens[0].amountBaseUnits).toBe('999999999999999999');
    expect(result.tokens[0].lamports).toBe(2039280);
  });
  it('rejects a positive account mislabelled empty by the backend',async()=>{
    const {wallet,data,token,connection}=setup();data.writeBigUInt64LE(1n,64);
    await expect(inspectCleanupTargets(connection as any,wallet,[token],[])).rejects.toThrow('Only empty canonical');
  });
  it('rejects noncanonical automatic targets',async()=>{
    const {wallet,token,connection}=setup(); token.pubKey=Keypair.generate().publicKey.toBase58();
    await expect(inspectCleanupTargets(connection as any,wallet,[token],[])).rejects.toThrow('canonical');
  });
  it.each(['owner','mint','program','state','closeAuthority','native'])('rejects unsafe %s',async(field)=>{
    const {wallet,data,account,token,connection}=setup();
    if(field==='owner') Keypair.generate().publicKey.toBuffer().copy(data,32);
    if(field==='mint') Keypair.generate().publicKey.toBuffer().copy(data,0);
    if(field==='program') account.owner=Keypair.generate().publicKey;
    if(field==='state') data[108]=2;
    if(field==='closeAuthority'){data.writeUInt32LE(1,129);Keypair.generate().publicKey.toBuffer().copy(data,133);}
    if(field==='native') data.writeUInt32LE(1,109);
    await expect(inspectCleanupTargets(connection as any,wallet,[token],[],[token.pubKey])).rejects.toThrow();
  });
  it('rejects duplicate targets before RPC',async()=>{
    const {wallet,token,connection}=setup();
    await expect(inspectCleanupTargets(connection as any,wallet,[token,token],[])).rejects.toThrow('duplicate');
    expect(connection.getMultipleAccountsInfo).not.toHaveBeenCalled();
  });
  it('decodes buffer authority and balance from RPC',async()=>{
    const {wallet,account,connection}=setup();account.data=Buffer.alloc(37);account.data.writeUInt32LE(1,0);account.data[4]=1;wallet.toBuffer().copy(account.data,5);account.owner=new PublicKey(BPF_LOADER_UPGRADEABLE);
    const result=await inspectCleanupTargets(connection as any,wallet,[],[{pubkey:Keypair.generate().publicKey.toBase58(),lamports:1}]);
    expect(result.buffers[0].authority).toBe(wallet.toBase58());
    expect(result.buffers[0].dataLength).toBe(37);
    expect(result.buffers[0].lamports).toBe(2039280);
  });
});
