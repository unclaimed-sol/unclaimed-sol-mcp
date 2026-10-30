import { describe, expect, it, vi } from 'vitest';
import { Keypair, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { verifyRewardFees } from '../../src/services/reward-validation.js';
import { validateTransactionPrograms, PUMP_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, ATA_PROGRAM_ID, USDC_MINT, derivePda, deriveAta } from '../../src/services/transaction.js';
import { FEE_VAULT } from '../../src/constants.js';
import { PublicKey } from '@solana/web3.js';

const wallet = Keypair.generate().publicKey;
const accumulator = derivePda(['user_volume_accumulator', wallet], PUMP_PROGRAM_ID);
const event = derivePda(['__event_authority'], PUMP_PROGRAM_ID);
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({pubkey,isWritable,isSigner});
const claim = () => new TransactionInstruction({ programId: PUMP_PROGRAM_ID,
  data: Buffer.from([37,58,35,126,190,53,228,197]),
  keys: [meta(wallet,true,true),meta(accumulator,true),meta(SystemProgram.programId),meta(event),meta(PUMP_PROGRAM_ID)] });
const close = () => new TransactionInstruction({ programId: PUMP_PROGRAM_ID,
  data: Buffer.from([249,69,164,218,150,103,84,138]),
  keys: [meta(wallet,true,true),meta(accumulator,true),meta(event),meta(PUMP_PROGRAM_ID)] });
const transfer = (lamports: number) => SystemProgram.transfer({fromPubkey:wallet,toPubkey:new PublicKey(FEE_VAULT),lamports});
function rpc(balance = 1100, owner = PUMP_PROGRAM_ID) {
  return { getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map(key => key.equals(accumulator) ? {owner,lamports:balance,data:Buffer.alloc(100),executable:false,rentEpoch:0} : null)),
    getMinimumBalanceForRentExemption: vi.fn(async () => 100) };
}
describe('locally observed Pump reward fees', () => {
  it('accepts exact integer fee and rejects one lamport more', async () => {
    await expect(verifyRewardFees(rpc(), [new Transaction().add(claim(),transfer(30))],wallet)).resolves.toBeUndefined();
    await expect(verifyRewardFees(rpc(), [new Transaction().add(claim(),transfer(31))],wallet)).rejects.toThrow('locally observed');
  });
  it('does not count withdrawn cashback again as close rent across transactions', async () => {
    await expect(verifyRewardFees(rpc(), [new Transaction().add(claim(),transfer(30)),new Transaction().add(close(),transfer(5))],wallet)).resolves.toBeUndefined();
    await expect(verifyRewardFees(rpc(), [new Transaction().add(claim(),transfer(30)),new Transaction().add(close(),transfer(6))],wallet)).rejects.toThrow('locally observed');
  });
  it('rejects duplicate claims and wrong source owners', async () => {
    await expect(verifyRewardFees(rpc(), [new Transaction().add(claim(),claim())],wallet)).rejects.toThrow('Duplicate');
    await expect(verifyRewardFees(rpc(1100,SystemProgram.programId), [new Transaction().add(claim())],wallet)).rejects.toThrow('owner');
  });
  it('rechecks changed balances rather than accepting the old fee cap', async () => {
    await expect(verifyRewardFees(rpc(101), [new Transaction().add(claim(),transfer(1))],wallet)).rejects.toThrow('locally observed');
  });
  it('validates the deployed Pump V2 USDC layout and its local token balance', async () => {
    const source = deriveAta(accumulator,USDC_MINT);
    const ix = new TransactionInstruction({programId:PUMP_PROGRAM_ID,data:Buffer.from([122,243,204,65,94,116,29,55]),keys:[
      meta(wallet,true,true),meta(accumulator,true),meta(USDC_MINT),meta(SPL_TOKEN_PROGRAM_ID),meta(ATA_PROGRAM_ID),meta(source,true),meta(deriveAta(wallet,USDC_MINT),true),meta(SystemProgram.programId),meta(event),meta(PUMP_PROGRAM_ID),
    ]});
    const data = Buffer.alloc(165); USDC_MINT.toBuffer().copy(data); accumulator.toBuffer().copy(data,32); data.writeBigUInt64LE(1000n,64); data[108]=1;
    const connection = rpc(); connection.getMultipleAccountsInfo.mockImplementation(async keys => keys.map(key => key.equals(source) ? {owner:SPL_TOKEN_PROGRAM_ID,lamports:100,data,executable:false,rentEpoch:0}:null));
    const tx = new Transaction().add(ix);
    expect(() => validateTransactionPrograms([tx],wallet,300,100_000_000,0,30n,'rewards')).not.toThrow();
    await expect(verifyRewardFees(connection,[tx],wallet)).resolves.toBeUndefined();
    ix.keys[5].pubkey=Keypair.generate().publicKey;
    expect(() => validateTransactionPrograms([tx],wallet,300,100_000_000,0,30n,'rewards')).toThrow();
  });
});
