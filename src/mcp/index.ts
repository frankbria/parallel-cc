/**
 * MCP Server for parallel-cc
 *
 * Exposes tools for Claude Code to query parallel session status
 * and manage merge detection (v0.4).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  GetParallelStatusInputSchema,
  GetParallelStatusOutputSchema,
  GetMySessionInputSchema,
  GetMySessionOutputSchema,
  NotifyWhenMergedInputSchema,
  NotifyWhenMergedOutputSchema,
  CheckMergeStatusInputSchema,
  CheckMergeStatusOutputSchema,
  CheckConflictsInputSchema,
  CheckConflictsOutputSchema,
  RebaseAssistInputSchema,
  RebaseAssistOutputSchema,
  GetMergeEventsInputSchema,
  GetMergeEventsOutputSchema
} from './schemas.js';
import {
  getParallelStatus,
  getMySession,
  notifyWhenMerged,
  checkMergeStatus,
  checkConflicts,
  rebaseAssist,
  getMergeEvents
} from './tools.js';

/**
 * Create and configure the MCP server with all tools
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'parallel-cc',
    version: '0.4.0'
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

  // Register notify_when_merged tool (v0.4 - full implementation)
  server.registerTool(
    'notify_when_merged',
    {
      title: 'Watch Branch for Merge',
      description: 'Subscribe to be notified when a branch is merged to main. Creates a subscription that the merge detection daemon will check. Requires running in a parallel-cc managed session.',
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

  // Register check_merge_status tool (v0.4)
  server.registerTool(
    'check_merge_status',
    {
      title: 'Check Merge Status',
      description: 'Check if a branch has been merged into the target branch (default: main). Returns merge event details if found.',
      inputSchema: CheckMergeStatusInputSchema,
      outputSchema: CheckMergeStatusOutputSchema
    },
    async (input) => {
      const output = await checkMergeStatus(input);
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      };
    }
  );

  // Register check_conflicts tool (v0.4)
  server.registerTool(
    'check_conflicts',
    {
      title: 'Check Conflicts',
      description: 'Check for merge/rebase conflicts between branches before attempting to merge or rebase. Returns list of conflicting files and guidance.',
      inputSchema: CheckConflictsInputSchema,
      outputSchema: CheckConflictsOutputSchema
    },
    async (input) => {
      const output = await checkConflicts(input);
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      };
    }
  );

  // Register rebase_assist tool (v0.4)
  server.registerTool(
    'rebase_assist',
    {
      title: 'Rebase Assist',
      description: 'Assist with rebasing current branch onto a target branch. Can check for conflicts only (checkOnly=true) or perform the actual rebase.',
      inputSchema: RebaseAssistInputSchema,
      outputSchema: RebaseAssistOutputSchema
    },
    async (input) => {
      const output = await rebaseAssist(input);
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      };
    }
  );

  // Register get_merge_events tool (v0.4)
  server.registerTool(
    'get_merge_events',
    {
      title: 'Get Merge Events',
      description: 'Get history of detected merge events. Can be filtered by repository path and limited in count.',
      inputSchema: GetMergeEventsInputSchema,
      outputSchema: GetMergeEventsOutputSchema
    },
    async (input) => {
      const output = await getMergeEvents(input);
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
export {
  getParallelStatus,
  getMySession,
  notifyWhenMerged,
  checkMergeStatus,
  checkConflicts,
  rebaseAssist,
  getMergeEvents
};
