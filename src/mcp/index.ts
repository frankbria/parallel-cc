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
  GetMergeEventsOutputSchema,
  ClaimFileInputSchema,
  ClaimFileOutputSchema,
  ReleaseFileInputSchema,
  ReleaseFileOutputSchema,
  ListFileClaimsInputSchema,
  ListFileClaimsOutputSchema,
  DetectAdvancedConflictsInputSchema,
  DetectAdvancedConflictsOutputSchema,
  GetAutoFixSuggestionsInputSchema,
  GetAutoFixSuggestionsOutputSchema,
  ApplyAutoFixInputSchema,
  ApplyAutoFixOutputSchema,
  ConflictHistoryInputSchema,
  ConflictHistoryOutputSchema
} from './schemas.js';
import {
  getParallelStatus,
  getMySession,
  notifyWhenMerged,
  checkMergeStatus,
  checkConflicts,
  rebaseAssist,
  getMergeEvents,
  claimFile,
  releaseFile,
  listFileClaims,
  detectAdvancedConflicts,
  getAutoFixSuggestions,
  applyAutoFix,
  conflictHistory
} from './tools.js';

/**
 * Create and configure the MCP server with all tools
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'parallel-cc',
    version: '0.5.0'
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

  // Register claim_file tool (v0.5)
  server.registerTool(
    'claim_file',
    {
      title: 'Claim File',
      description: 'Acquire a claim on a file to prevent concurrent edits. Supports EXCLUSIVE (blocks all), SHARED (allows read), and INTENT (non-blocking) modes. Requires running in a parallel-cc managed session.',
      inputSchema: ClaimFileInputSchema,
      outputSchema: ClaimFileOutputSchema
    },
    async (input) => {
      const output = await claimFile(input);
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      };
    }
  );

  // Register release_file tool (v0.5)
  server.registerTool(
    'release_file',
    {
      title: 'Release File',
      description: 'Release a previously acquired file claim. Use the claim ID from claim_file.',
      inputSchema: ReleaseFileInputSchema,
      outputSchema: ReleaseFileOutputSchema
    },
    async (input) => {
      const output = await releaseFile(input);
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      };
    }
  );

  // Register list_file_claims tool (v0.5)
  server.registerTool(
    'list_file_claims',
    {
      title: 'List File Claims',
      description: 'List all active file claims with optional filters (file paths, session ID, include expired). Shows who has claimed which files and when claims expire.',
      inputSchema: ListFileClaimsInputSchema,
      outputSchema: ListFileClaimsOutputSchema
    },
    async (input) => {
      const output = await listFileClaims(input);
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      };
    }
  );

  // Register detect_advanced_conflicts tool (v0.5)
  server.registerTool(
    'detect_advanced_conflicts',
    {
      title: 'Detect Advanced Conflicts',
      description: 'Detect and classify merge/rebase conflicts with AST-based semantic analysis. Identifies conflict types (STRUCTURAL, SEMANTIC, CONCURRENT_EDIT, TRIVIAL) and severity levels.',
      inputSchema: DetectAdvancedConflictsInputSchema,
      outputSchema: DetectAdvancedConflictsOutputSchema
    },
    async (input) => {
      const output = await detectAdvancedConflicts(input);
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      };
    }
  );

  // Register get_auto_fix_suggestions tool (v0.5)
  server.registerTool(
    'get_auto_fix_suggestions',
    {
      title: 'Get Auto-Fix Suggestions',
      description: 'Generate AI-powered conflict resolution suggestions for a file. Returns multiple strategies ranked by confidence score with preview and risk assessment.',
      inputSchema: GetAutoFixSuggestionsInputSchema,
      outputSchema: GetAutoFixSuggestionsOutputSchema
    },
    async (input) => {
      const output = await getAutoFixSuggestions(input);
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      };
    }
  );

  // Register apply_auto_fix tool (v0.5)
  server.registerTool(
    'apply_auto_fix',
    {
      title: 'Apply Auto-Fix',
      description: 'Apply an auto-fix suggestion to resolve conflicts. Includes safety checks: backup creation, syntax validation, conflict marker verification, and rollback commands.',
      inputSchema: ApplyAutoFixInputSchema,
      outputSchema: ApplyAutoFixOutputSchema
    },
    async (input) => {
      const output = await applyAutoFix(input);
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      };
    }
  );

  // Register conflict_history tool (v0.5)
  server.registerTool(
    'conflict_history',
    {
      title: 'Conflict History',
      description: 'Get conflict resolution history with statistics. Shows past resolutions, auto-fix rates, average confidence scores, and resolution strategies used.',
      inputSchema: ConflictHistoryInputSchema,
      outputSchema: ConflictHistoryOutputSchema
    },
    async (input) => {
      const output = await conflictHistory(input);
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
  getMergeEvents,
  claimFile,
  releaseFile,
  listFileClaims,
  detectAdvancedConflicts,
  getAutoFixSuggestions,
  applyAutoFix,
  conflictHistory
};
