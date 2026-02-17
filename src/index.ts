#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { ScannerService } from './services/scanner.js';
import { TransactionBuilder } from './services/transaction.js';
import { SignerService } from './services/signer.js';
import { getScanToolDefinition, handleScan } from './tools/scan.js';
import { getClaimToolDefinition, handleClaim } from './tools/claim.js';

async function main() {
  const config = loadConfig();
  const scanner = new ScannerService(config);
  const txBuilder = config.claimEnabled
    ? new TransactionBuilder(config)
    : null;
  const signer = config.claimEnabled ? new SignerService(config) : null;

  const server = new Server(
    { name: 'unclaimed-sol-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [getScanToolDefinition()];
    if (config.claimEnabled) tools.push(getClaimToolDefinition());
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'scan_claimable_sol') {
      return handleScan(args, config, scanner);
    }

    if (name === 'claim_sol') {
      if (!config.claimEnabled || !txBuilder || !signer) {
        return {
          content: [
            {
              type: 'text',
              text: 'Vibe Claiming not configured. Set SOLANA_KEYPAIR_PATH to enable — see https://unclaimedsol.com',
            },
          ],
          isError: true,
        };
      }
      return handleClaim(args, config, scanner, txBuilder, signer);
    }

    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('unclaimed-sol-mcp v1.0.0');
  console.error(`  API: ${config.apiUrl}`);
  console.error(`  RPC: ${config.rpcUrl}`);
  console.error(
    `  Vibe Claiming: ${config.claimEnabled ? 'ENABLED' : 'disabled'}`,
  );
  if (config.claimEnabled)
    console.error(`  Wallet: ${config.keypair!.publicKey.toBase58()}`);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
