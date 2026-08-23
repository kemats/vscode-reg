import * as vscode from 'vscode';
import { HiveSessionPool } from './hiveClient';
import { normalizeResultLimit } from './hiveMetadata';

interface ReadInput { path: string; key?: string }
interface SearchInput { path: string; query: string; limit?: number }
interface QueryInput { path: string; where: string; limit?: number }

function result(value: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(value, null, 2)),
  ]);
}

export function registerLmTools(context: vscode.ExtensionContext, pool: HiveSessionPool): void {
  context.subscriptions.push(
    vscode.lm.registerTool<ReadInput>('registry_read_hive', {
      async invoke(options, token) {
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
        const client = await pool.get(options.input.path);
        const listing = await client.list(options.input.key ?? '');
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
        return result(listing);
      },
      prepareInvocation(options) {
        return { invocationMessage: `Reading ${options.input.key || 'hive root'}` };
      },
    }),
    vscode.lm.registerTool<SearchInput>('registry_search_hive', {
      async invoke(options, token) {
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
        const client = await pool.get(options.input.path);
        const response = await client.search(options.input.query, normalizeResultLimit(options.input.limit));
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
        return result(response);
      },
      prepareInvocation(options) {
        return { invocationMessage: `Searching registry hive for “${options.input.query}”` };
      },
    }),
    vscode.lm.registerTool<QueryInput>('registry_query_hive', {
      async invoke(options, token) {
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
        const client = await pool.get(options.input.path);
        const response = await client.query(options.input.where, normalizeResultLimit(options.input.limit));
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
        return result(response);
      },
      prepareInvocation(options) {
        return { invocationMessage: `Querying registry hive with WHERE ${options.input.where}` };
      },
    }),
  );
}
