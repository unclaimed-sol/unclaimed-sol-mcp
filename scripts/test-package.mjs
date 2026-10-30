import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
