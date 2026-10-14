import { afterEach, describe, expect, it, vi } from 'vitest';
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
