// Local-only integration: generated test keys and an isolated validator ledger.
// No signing or sending code from this harness is included in the npm package.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { PROGRAM_ID, FEE_RECIPIENT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@unclaimedsol/spl-burn-close-sdk';
import { TransactionBuilder } from '../dist/services/transaction.js';
import { SignerService } from '../dist/services/signer.js';
import { inspectCleanupTargets } from '../dist/services/cleanup-validation.js';
import { handleClaim } from '../dist/tools/claim.js';

const rustRoot = resolve(process.argv[2] ?? '../unclaimed-sol-rust-program');
const rustCommit = '1f2b10ae668c47de97627de69cdf656878ed9b0e';
const artifactHash = '40c9eb68c0a6e835d8789e87da2aa5f67b9cb18498814078b75e2129b44054aa';
const artifact = join(rustRoot, 'target/deploy/unclaimedsol.so');
assert.equal(execFileSync('git', ['diff', rustCommit, 'HEAD', '--', 'src', 'Cargo.toml', 'Cargo.lock'], { cwd: rustRoot, encoding: 'utf8' }), '');
assert.equal(execFileSync('git', ['status', '--porcelain', '--', 'src', 'Cargo.toml', 'Cargo.lock'], { cwd: rustRoot, encoding: 'utf8' }), '');
assert.equal(createHash('sha256').update(readFileSync(artifact)).digest('hex'), artifactHash);
assert.deepEqual(readFileSync(join(rustRoot, 'tests/fixtures/close_empty_token_accounts.json')),
  readFileSync(new URL('../test/fixtures/close_empty_token_accounts.json', import.meta.url)));

const temp = mkdtempSync(join(tmpdir(), 'mcp-close-empty-runtime-'));
const rpcPort = 19899;
const rpcUrl = `http://127.0.0.1:${rpcPort}`;
const payer = Keypair.generate();
const rent = 2_039_280;
const fee = 40_785;
const walletBalance = 10_000_000;
const feeBalance = 1_000_000;
const args = ['--ledger', join(temp, 'ledger'), '--bind-address', '127.0.0.1',
  '--rpc-port', String(rpcPort), '--faucet-port', '19901', '--gossip-port', '19902',
  '--dynamic-port-range', '19910-19940', '--mint', payer.publicKey.toBase58(),
  '--bpf-program', PROGRAM_ID.toBase58(), artifact, '--quiet'];

function genesisAccount(pubkey, owner, data, lamports) {
  const filename = join(temp, `${pubkey}.json`);
  writeFileSync(filename, JSON.stringify({ pubkey: pubkey.toBase58(), account: {
    lamports, owner: owner.toBase58(), data: [data.toString('base64'), 'base64'],
    executable: false, rentEpoch: 0,
  } }));
  args.push('--account', pubkey.toBase58(), filename);
}

// Base SPL layouts shared by classic and Token-2022 (no extensions in this test).
function mintData(supply, decimals) {
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(BigInt(supply), 36);
  data[44] = decimals;
  data[45] = 1; // initialized
  return data;
}

function tokenData(mint, owner, amount, native = false) {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(BigInt(amount), 64);
  data[108] = 1; // Initialized, not Frozen
  if (native) {
    data.writeUInt32LE(1, 109);
    data.writeBigUInt64LE(BigInt(rent), 113);
  }
  return data;
}

genesisAccount(FEE_RECIPIENT, SystemProgram.programId, Buffer.alloc(0), feeBalance);
const cases = [
  [TOKEN_PROGRAM_ID, new PublicKey('So11111111111111111111111111111111111111112')],
  [TOKEN_2022_PROGRAM_ID, new PublicKey('9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP')],
].map(([program, nativeMint]) => {
  const wallet = Keypair.generate();
  const [mint, source, empty, late, nativeEmpty, nativeFunded, unsynchronized] =
    Array.from({ length: 7 }, () => Keypair.generate().publicKey);
  genesisAccount(wallet.publicKey, SystemProgram.programId, Buffer.alloc(0), walletBalance);
  genesisAccount(mint, program, mintData(25, 6), 1_461_600);
  genesisAccount(nativeMint, program, mintData(0, 9), 1_461_600);
  for (const [address, amount] of [[source, 25], [empty, 0], [late, 0]]) {
    genesisAccount(address, program, tokenData(mint, wallet.publicKey, amount), rent);
  }
  for (const [address, amount] of [[nativeEmpty, 0], [nativeFunded, 1_000_000], [unsynchronized, 0]]) {
    genesisAccount(address, program, tokenData(nativeMint, wallet.publicKey, amount, true), rent + amount);
  }
  const batch = Array.from({ length: 12 }, () => {
    const mintKey = Keypair.generate().publicKey, tokenKey = Keypair.generate().publicKey;
    genesisAccount(mintKey, program, mintData(0, 6), 1_461_600);
    genesisAccount(tokenKey, program, tokenData(mintKey, wallet.publicKey, 0), rent);
    return { mint: mintKey, ata: tokenKey };
  });
  const buffer = Keypair.generate().publicKey;
  const bufferData = Buffer.alloc(69); bufferData.writeUInt32LE(1); bufferData[4] = 1;
  wallet.publicKey.toBuffer().copy(bufferData, 5);
  genesisAccount(buffer, new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'), bufferData, 2_000_000);
  return { program, wallet, mint, source, empty, late, nativeMint, nativeEmpty, nativeFunded, unsynchronized, batch, buffer };
});

console.log(JSON.stringify({ rustCommit, artifactHash, validator: execFileSync('solana-test-validator', ['--version'], { encoding: 'utf8' }).trim(), ledger: temp }));
const logFd = openSync(join(temp, 'validator.log'), 'w');
const validator = spawn('solana-test-validator', args, { stdio: ['ignore', logFd, logFd] });
closeSync(logFd);
let launchError;
validator.on('error', error => { launchError = error; });
const exited = new Promise(resolveExit => validator.once('close', resolveExit));
const connection = new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true });

async function submit(tx, wallet) {
  tx.sign(payer, wallet);
  const signature = await connection.sendRawTransaction(tx.serialize());
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (result) {
      assert.equal(result.meta.err, null, JSON.stringify(result.meta));
      return result.meta.logMessages;
    }
    await delay(250);
  }
  throw new Error(`Local transaction confirmation timed out: ${signature}`);
}

async function transaction(instructions) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  return new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(...instructions);
}

async function accountStates(keys) {
  const accounts = await connection.getMultipleAccountsInfo(keys);
  // The runtime normalizes rentEpoch on first use, including built-in native
  // mints. Compare every other field: data, lamports, owner and privileges.
  return accounts.map(account => {
    assert.ok(account, 'Preserved account must still exist');
    const { rentEpoch, ...state } = account;
    return state;
  });
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (launchError) throw launchError;
    if (validator.exitCode !== null) throw new Error(`Validator exited ${validator.exitCode}; see ${temp}/validator.log`);
    try {
      // Genesis SBF programs are not invokable in their deployment slot.
      if (await connection.getSlot() > 1) { ready = true; break; }
    } catch { /* RPC is still starting. */ }
    await delay(500);
  }
  assert.ok(ready, `Local validator did not start; see ${temp}/validator.log`);
  // Refuse to send to an unrelated validator already occupying the test port.
  assert.ok((await connection.getBalance(payer.publicKey)) > 0, 'Expected generated genesis payer');
  for (const c of cases) {
    const { program, wallet, mint, source, empty, late, nativeMint, nativeEmpty, nativeFunded, unsynchronized, batch, buffer } = c;
    assert.equal((await connection.getAccountInfo(program)).executable, true);
    const config = { apiUrl: 'https://unclaimedsol.com', apiKey: null, rpcUrl, keypair: wallet, priorityFee: 1000, claimEnabled: true };
    const builder = new TransactionBuilder(config);
    const signer = new SignerService(config);
    const target = (ata, mintKey = mint) => ({ pubKey: ata.toBase58(), mintKey: mintKey.toBase58(), programOwnerId: program.toBase58(), amountUi: 0, isFrozen: false, lamports: rent });
    const targets = [target(empty), target(late), ...[nativeEmpty, nativeFunded, unsynchronized].map(ata => target(ata, nativeMint))];
    const preview = await inspectCleanupTargets(connection, wallet.publicKey, targets, []);
    assert.equal(preview.tokens.length, 4); // Funded WSOL is excluded before building.
    const plan = await builder.buildClaimPlan(preview.tokens, [], wallet.publicKey, 10);
    builder.validateTransactions(plan.transactions, wallet.publicKey);
    assert.deepEqual([...plan.transactions[0].instructions[2].data], [2]);
    assert.ok(plan.transactions[0].signatures.every(({ signature }) => signature === null));
    // Build while empty, then execute actual deposits before the SDK transaction.
    const transferData = Buffer.alloc(10);
    transferData[0] = 12; // TransferChecked
    transferData.writeBigUInt64LE(25n, 1);
    transferData[9] = 6;
    const deposit = new TransactionInstruction({ programId: program, data: transferData, keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: late, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
    ] });
    await submit(await transaction([deposit, SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: unsynchronized, lamports: 999 })]), wallet);
    const preservedKeys = [late, nativeFunded, unsynchronized, mint, nativeMint];
    const before = await accountStates(preservedKeys);
    assert.equal(before[0].data.readBigUInt64LE(64), 25n);
    assert.equal(before[2].data.readBigUInt64LE(64), 0n);
    const recipientBefore = await connection.getBalance(FEE_RECIPIENT);
    const walletBefore = await connection.getBalance(wallet.publicKey);
    const results = await signer.signAndSendBatch(plan.transactions, wallet);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'confirmed', JSON.stringify(results));
    const landed = await connection.getTransaction(results[0].signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    assert.ok(landed && !landed.meta.err);
    const logs = landed.meta.logMessages;
    assert.ok(logs.some(log => log.includes('us:event:close_empty_summary closed=2')));
    assert.ok(!logs.some(log => /Instruction: (Burn|SyncNative)/.test(log)));
    assert.equal(await connection.getAccountInfo(empty), null);
    assert.equal(await connection.getAccountInfo(nativeEmpty), null);
    assert.deepEqual(await accountStates(preservedKeys), before);
    assert.equal(await connection.getBalance(FEE_RECIPIENT), recipientBefore + 2 * fee);
    assert.equal(await connection.getBalance(wallet.publicKey), walletBefore + 2 * (rent - fee) - landed.meta.fee);

    const skippedPlan = await builder.buildClaimPlan([target(late)], [], wallet.publicKey, 10);
    const skipWalletBefore = await connection.getBalance(wallet.publicKey);
    const skippedResults = await signer.signAndSendBatch(skippedPlan.transactions, wallet);
    assert.deepEqual(skippedResults, [{ signature: '', status: 'failed', error: 'NO_RECOVERY: no eligible token accounts; not submitted' }]);
    assert.deepEqual(await accountStates(preservedKeys), before);
    assert.equal(await connection.getBalance(FEE_RECIPIENT), recipientBefore + 2 * fee);
    assert.equal(await connection.getBalance(wallet.publicKey), skipWalletBefore);
    // Exercise the actual tool's token/exclusion/orchestration path and the
    // existing 12-pair batch size, plus unchanged buffer selector 1.
    const scanner = {
      getClaimableTokens: async () => ({ tokens: batch.map(pair => target(pair.ata, pair.mint)) }),
      getClaimableBuffers: async () => ({ buffers: [{ pubkey: buffer.toBase58(), lamports: 2_000_000 }] }),
      getClaimableStakes: async () => ({ count: 0, estimatedSol: 0 }),
    };
    const batchPreview = await handleClaim({}, config, scanner, builder, signer);
    assert.ok(!batchPreview.isError, JSON.stringify(batchPreview));
    const executionToken = /Execution token: ([a-f0-9]{32})/.exec(batchPreview.content[0].text)?.[1];
    assert.ok(executionToken);
    const batchRecipientBefore = await connection.getBalance(FEE_RECIPIENT);
    const completed = await handleClaim({ dry_run: false, execution_token: executionToken }, config, scanner, builder, signer);
    assert.ok(!completed.isError, JSON.stringify(completed));
    assert.ok(completed.content[0].text.includes('Confirmed 2 transactions targeting 12 token accounts and 1 buffer accounts'), completed.content[0].text);
    assert.ok(completed.content[0].text.includes('not verified closures'));
    for (const pair of batch) assert.equal(await connection.getAccountInfo(pair.ata), null);
    assert.equal(await connection.getAccountInfo(buffer), null);
    assert.equal(await connection.getBalance(FEE_RECIPIENT), batchRecipientBefore + 12 * fee + 100_000);
    assert.equal((await handleClaim({ dry_run: false, execution_token: executionToken }, config, scanner, builder, signer)).isError, true);
    const signatures = [...completed.content[0].text.matchAll(/^\d+\. ([1-9A-HJ-NP-Za-km-z]+)$/gm)].map(match => match[1]);
    const measures = [];
    for (const signature of signatures) {
      const result = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      assert.ok(result && !result.meta.err);
      measures.push({ units: result.meta.computeUnitsConsumed, wireBytes: 1 + result.transaction.signatures.length * 64 + result.transaction.message.serialize().length });
    }
    console.log(`PASS ${program}: MCP tool + preview/build/sign/send, late deposits preserved, all-skipped not submitted, 12 distinct-mint targets + buffer, replay rejected; ${JSON.stringify(measures)}`);

  }
} finally {
  validator.kill('SIGTERM');
  await Promise.race([exited, delay(5000)]);
  if (validator.exitCode === null && validator.signalCode === null) {
    validator.kill('SIGKILL');
    await exited;
  }
  console.log(`Local validator evidence retained at ${temp}`);
}
// web3.js confirmation clients keep reconnect timers after the validator exits.
// This disposable test process exits only after assertions and child cleanup.
process.exit(0);
