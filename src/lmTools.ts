import * as vscode from 'vscode';
import { HiveSessionPool } from './hiveClient';
import { normalizeResultLimit } from './hiveMetadata';
import { createHiveLocationUri } from './hiveLinks';
import { KeyListing, SearchResponse } from './types';

interface ReadInput { path: string; key?: string }
interface SearchInput { path: string; query: string; limit?: number }
interface QueryInput { path: string; where: string; limit?: number }

function result(value: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(value, null, 2)),
  ]);
}

function locationLink(context: vscode.ExtensionContext, path: string, key: string, value?: string): string {
  return createHiveLocationUri(vscode.env.uriScheme, context.extension.id, { path, key, value });
}

function linkedListing(context: vscode.ExtensionContext, path: string, listing: KeyListing): unknown {
  return {
    ...listing,
    openUri: locationLink(context, path, listing.path),
    subkeys: listing.subkeys.map(subkey => ({
      ...subkey,
      openUri: locationLink(context, path, listing.path ? `${listing.path}\\${subkey.name}` : subkey.name),
    })),
    values: listing.values.map(value => ({
      ...value,
      openUri: locationLink(context, path, listing.path, value.rawName),
    })),
  };
}

function linkedSearchResponse(context: vscode.ExtensionContext, path: string, response: SearchResponse): unknown {
  return {
    ...response,
    results: response.results.map(match => ({
      ...match,
      openUri: locationLink(context, path, match.key, match.value?.rawName),
    })),
  };
}

export function registerLmTools(context: vscode.ExtensionContext, pool: HiveSessionPool): void {
  context.subscriptions.push(
    vscode.lm.registerTool<ReadInput>('registry_read_hive', {
      async invoke(options, token) {
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
        const client = await pool.get(options.input.path);
        const listing = await client.list(options.input.key ?? '');
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
        return result(linkedListing(context, options.input.path, listing));
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
        return result(linkedSearchResponse(context, options.input.path, response));
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
        return result(linkedSearchResponse(context, options.input.path, response));
      },
      prepareInvocation(options) {
        return { invocationMessage: `Querying registry hive with WHERE ${options.input.where}` };
      },
    }),
  );
}
