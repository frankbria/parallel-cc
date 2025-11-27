/**
 * MCP Server for parallel-cc
 *
 * Exposes tools for Claude Code to query parallel session status.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  GetParallelStatusInputSchema,
  GetParallelStatusOutputSchema,
  GetMySessionInputSchema,
  GetMySessionOutputSchema,
  NotifyWhenMergedInputSchema,
  NotifyWhenMergedOutputSchema
} from './schemas.js';
import {
  getParallelStatus,
  getMySession,
  notifyWhenMerged
} from './tools.js';

/**
 * Create and configure the MCP server with all tools
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'parallel-cc',
    version: '0.3.0'
  });

  // Register get_parallel_status tool
  server.registerTool(
    'get_parallel_status',
    {
      title: 'Get Parallel Status',
      description: 'Get status of all parallel Claude Code sessions in this repository. Returns information about active sessions including their PIDs, worktree paths, and whether processes are still alive.',
      inputSchema: GetParallelStatusInputSchema,
      outputSchema: GetParallelStatusOutputSchema
    },
    async (input) => {
      const output = await getParallelStatus(input);
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      };
    }
  );

  // Register get_my_session tool
  server.registerTool(
    'get_my_session',
    {
      title: 'Get My Session',
      description: 'Get information about the current Claude Code session. Requires the PARALLEL_CC_SESSION_ID environment variable to be set (automatically done by claude-parallel wrapper).',
      inputSchema: GetMySessionInputSchema,
      outputSchema: GetMySessionOutputSchema
    },
    async () => {
      const output = await getMySession();
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      };
    }
  );

  // Register notify_when_merged tool (stub for v0.3)
  server.registerTool(
    'notify_when_merged',
    {
      title: 'Watch Branch for Merge',
      description: 'Subscribe to be notified when a branch is merged to main. Note: This is a placeholder in v0.3. Full merge detection will be implemented in v0.4.',
      inputSchema: NotifyWhenMergedInputSchema,
      outputSchema: NotifyWhenMergedOutputSchema
    },
    async (input) => {
      const output = await notifyWhenMerged(input);
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      };
    }
  );

  return server;
}

/**
 * Start the MCP server with stdio transport
 * This is the main entry point when running `parallel-cc mcp-serve`
 */
export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Export for testing
export { getParallelStatus, getMySession, notifyWhenMerged };
