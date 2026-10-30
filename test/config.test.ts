import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { loadConfig, logHost } from '../src/config.js';

afterEach(() => vi.unstubAllEnvs());
describe('configuration privacy', () => {
  it('logs only the hostname', () => {
    expect(logHost('https://user:password@rpc.example/private-key?api-key=secret#fragment')).toBe('rpc.example');
    expect(logHost('secret-invalid-url')).toBe('[invalid URL]');
  });
  it.each(['http://unclaimedsol.com', 'https://evil.example', 'https://unclaimedsol.com@evil.example', 'https://unclaimedsol.com/?api-key=secret'])('rejects unsafe API key destination %s even without signing enabled', url => {
    vi.stubEnv('UNCLAIMED_SOL_API_URL', url);
    vi.stubEnv('UNCLAIMED_SOL_API_KEY', 'test-only');
    vi.stubEnv('SOLANA_KEYPAIR_PATH', '');
    vi.stubEnv('SOLANA_PRIVATE_KEY', '');
    vi.stubEnv('UNCLAIMED_SOL_ALLOW_DEV_API', '');
    expect(() => loadConfig()).toThrow();
  });
  it('permits local HTTP only with an explicit development override', () => {
    vi.stubEnv('UNCLAIMED_SOL_API_URL', 'http://localhost:3000');
    vi.stubEnv('UNCLAIMED_SOL_API_KEY', 'test-only');
    vi.stubEnv('SOLANA_KEYPAIR_PATH', '');
    vi.stubEnv('SOLANA_PRIVATE_KEY', '');
    vi.stubEnv('UNCLAIMED_SOL_ALLOW_DEV_API', '');
    expect(() => loadConfig()).toThrow();
    vi.stubEnv('UNCLAIMED_SOL_ALLOW_DEV_API', 'true');
    expect(loadConfig().apiUrl).toBe('http://localhost:3000');
  });
});

describe('safe configuration diagnostics', () => {
  const directories: string[] = [];
  beforeEach(() => {
    for (const name of ['SOLANA_KEYPAIR_PATH', 'SOLANA_PRIVATE_KEY', 'UNCLAIMED_SOL_API_KEY',
      'UNCLAIMED_SOL_API_URL', 'UNCLAIMED_SOL_ALLOW_DEV_API', 'SOLANA_RPC_URL']) vi.stubEnv(name, '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
    vi.restoreAllMocks();
  });
  const keypairFile = (contents?: string) => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-config-test-'));
    directories.push(directory);
    const file = join(directory, 'PRIVATE_PATH_MARKER.json');
    if (contents !== undefined) writeFileSync(file, contents);
    vi.stubEnv('SOLANA_KEYPAIR_PATH', file);
  };
  it('distinguishes an unreadable keypair file without exposing its path', () => {
    keypairFile();
    expect(() => loadConfig()).toThrow('Cannot read SOLANA_KEYPAIR_PATH; check the file path and permissions.');
  });
  it.each(['[PRIVATE_CONTENT_MARKER', '{}', '[1,2,3]'])('redacts invalid keypair-file contents %s', contents => {
    keypairFile(contents);
    expect(() => loadConfig()).toThrow('Keypair file is not valid JSON or not a 64-byte secret key.');
  });
  it.each(['[PRIVATE_CONTENT_MARKER', 'invalid-base58-0', '[1,2,3]'])('redacts invalid private-key input %s', value => {
    vi.stubEnv('SOLANA_PRIVATE_KEY', value);
    expect(() => loadConfig()).toThrow('SOLANA_PRIVATE_KEY must contain a valid 64-byte secret key as base58 or a JSON byte array.');
  });
  it('rejects JSON values that Uint8Array would silently coerce', () => {
    const bytes = Array.from(Keypair.generate().secretKey);
    bytes[0] += 256;
    keypairFile(JSON.stringify(bytes));
    expect(() => loadConfig()).toThrow('Keypair file is not valid JSON or not a 64-byte secret key.');
  });
  it('reports malformed API URLs without exposing their contents', () => {
    vi.stubEnv('UNCLAIMED_SOL_API_KEY', 'test-only');
    vi.stubEnv('UNCLAIMED_SOL_API_URL', 'PRIVATE_URL_MARKER');
    expect(() => loadConfig()).toThrow('UNCLAIMED_SOL_API_URL must be a valid URL.');
  });
  it.each(['file', 'json', 'base58'])('continues to load valid %s keypairs', format => {
    const keypair = Keypair.generate();
    const json = JSON.stringify(Array.from(keypair.secretKey));
    if (format === 'file') keypairFile(json);
    else vi.stubEnv('SOLANA_PRIVATE_KEY', format === 'json' ? json : bs58.encode(keypair.secretKey));
    expect(loadConfig().keypair?.publicKey.equals(keypair.publicKey)).toBe(true);
  });
});
