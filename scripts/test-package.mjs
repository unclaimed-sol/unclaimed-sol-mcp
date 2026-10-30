import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Keypair } from '@solana/web3.js';

const root = resolve('.');
const temp = mkdtempSync(join(tmpdir(), 'mcp-package-smoke-'));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], { cwd: root, encoding: 'utf8' }));
assert.ok(packed.files.every(({ path }) => path.startsWith('dist/') || ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'].includes(path)));
assert.ok(packed.files.some(({ path }) => path === 'dist/services/cleanup-simulation.js'));
writeFileSync(join(temp, 'package.json'), JSON.stringify({ name: 'mcp-package-smoke', version: '1.0.0', private: true }));
execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, packed.filename)], { cwd: temp, stdio: 'inherit' });
const installed = join(temp, 'node_modules/@unclaimed-sol/mcp');
const sdk = JSON.parse(readFileSync(join(temp, 'node_modules/@unclaimedsol/spl-burn-close-sdk/package.json'), 'utf8'));
assert.equal(sdk.version, '1.4.0');
assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, manifest.version);

const keypairPath = join(temp, 'generated-test-keypair.json');
writeFileSync(keypairPath, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 });
const invalidKeypairPath = join(temp, 'PRIVATE_PATH_MARKER.json');
writeFileSync(invalidKeypairPath, '[PRIVATE_CONTENT_MARKER');
const startupCases = [
  { name: 'unreadable file', env: { SOLANA_KEYPAIR_PATH: join(temp, 'MISSING_PATH_MARKER.json') }, expected: 'Cannot read SOLANA_KEYPAIR_PATH' },
  { name: 'invalid file', env: { SOLANA_KEYPAIR_PATH: invalidKeypairPath }, expected: 'Keypair file is not valid JSON or not a 64-byte secret key' },
  { name: 'invalid private key', env: { SOLANA_PRIVATE_KEY: '[PRIVATE_CONTENT_MARKER' }, expected: 'SOLANA_PRIVATE_KEY must contain a valid 64-byte secret key' },
  { name: 'disallowed API host', env: { UNCLAIMED_SOL_API_KEY: 'PRIVATE_API_KEY_MARKER', UNCLAIMED_SOL_API_URL: 'https://PRIVATE_HOST_MARKER.invalid' }, expected: 'UNCLAIMED_SOL_API_URL must use unclaimedsol.com' },
  { name: 'malformed API URL', env: { UNCLAIMED_SOL_API_KEY: 'PRIVATE_API_KEY_MARKER', UNCLAIMED_SOL_API_URL: 'PRIVATE_URL_MARKER' }, expected: 'UNCLAIMED_SOL_API_URL must be a valid URL' },
  { name: 'unexpected startup failure', env: { SOLANA_KEYPAIR_PATH: keypairPath, SOLANA_RPC_URL: 'PRIVATE_RPC_MARKER' }, expected: 'MCP_STARTUP_FAILED' },
];
for (const { name, env, expected } of startupCases) {
  const result = spawnSync(process.execPath, [join(installed, 'dist/index.js')], {
    cwd: temp, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, name);
  assert.equal(result.stdout, '', name);
  assert.ok(result.stderr.includes(expected), `${name}: ${result.stderr}`);
  assert.ok(!result.stderr.includes('MARKER') && !result.stderr.includes(temp), `${name}: private input leaked`);
}
console.log('PASS installed startup diagnostics: six failures classified without private input leaks');
for (const claiming of [false, true]) {
  const client = new Client({ name: 'package-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(installed, 'dist/index.js')], cwd: temp, stderr: 'pipe',
    // No production signing keys/API credentials are inherited by the child.
    env: { PATH: process.env.PATH ?? '', ...(claiming ? { SOLANA_KEYPAIR_PATH: keypairPath } : {}) },
  });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().version, manifest.version);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), claiming
      ? ['claim_rewards', 'claim_sol', 'claim_stakes', 'scan_claimable_sol']
      : ['scan_claimable_sol']);
    const invalid = await client.callTool({ name: 'scan_claimable_sol', arguments: { wallet_address: 'not-a-wallet' } });
    assert.equal(invalid.isError, true);
    if (claiming) {
      const noToken = await client.callTool({ name: 'claim_sol', arguments: { dry_run: false, execution_token: 'invalid' } });
      assert.equal(noToken.isError, true);
      assert.match(JSON.stringify(noToken), /token/i);
    }
    console.log(`PASS installed stdio ${claiming ? 'claim-enabled' : 'read-only'}: initialize, tool discovery, invalid input${claiming ? ', execution-token rejection' : ''}`);
  } finally {
    await client.close();
  }
}
console.log(`Packed artifact and installed consumer retained at ${temp}`);
