/**
 * Optional web search, in two flavours:
 *
 * 1. **Provider-native** — some OpenAI-compatible providers can search the web
 *    themselves when the chat request asks for it (`nativeSearchFor`). No extra
 *    key, but the mechanism differs per vendor and only some vendors support it.
 * 2. **Plugin tool** — a `web_search` tool backed by Tavily, for providers with
 *    no native search (DeepSeek, for instance). Needs a Tavily API key.
 *
 * No Obsidian import: the mapping and the response formatting are pure, and the
 * HTTP call is injected, so this module is unit-testable in Node.
 */

import { truncate, type ToolDef, type ToolExecutor } from './agent';

export type SearchMode = 'off' | 'auto' | 'native' | 'tool';
export type SearchDepth = 'basic' | 'advanced';

export interface SearchSettings {
	mode: SearchMode;
	providerId: string;
	/** Tavily API key; only needed by the plugin tool. */
	apiKey: string;
	maxResults: number;
	depth: SearchDepth;
}

export interface NativeSearch {
	/** Raw entries appended to the request body's `tools` array, untouched. */
	tools?: unknown[];
	/** Top-level request body fields (`enable_search`, `plugins`, …). */
	extraBody?: Record<string, unknown>;
	/** Built-in tool names the client must echo back instead of executing. */
	passthrough?: string[];
}

export interface ResolvedSearch {
	native: NativeSearch | null;
	tool: boolean;
	reason?: 'off' | 'provider-unsupported' | 'no-key';
}

export const WEB_SEARCH_TOOL_NAME = 'web_search';
export const TAVILY_URL = 'https://api.tavily.com/search';

export type SearchPost = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>;

/**
 * Per-provider native search declaration, or `null` when the provider has none.
 *
 * Kept in one place because every entry here is a vendor-specific request
 * shape that cannot be exercised without that vendor's API key.
 */
export function nativeSearchFor(providerId: string, maxResults: number): NativeSearch | null {
	const count = clampResults(maxResults);
	switch (providerId) {
		case 'glm':
		case 'zai':
			// Per Zhipu's "Web Search in Chat" doc the flags are string-typed in
			// their example ("True"/"5"). If a vendor rejects this, the caller
			// retries once without the native declaration — see agent.ts.
			return {
				tools: [
					{
						type: 'web_search',
						web_search: {
							enable: 'True',
							search_engine: 'search_pro',
							search_result: 'True',
							count: String(count)
						}
					}
				]
			};
		case 'kimi':
			// Server-side built-in: the model returns a $web_search tool_call and
			// the client echoes the arguments back verbatim, which triggers the
			// actual search on the next round. Moonshot is retiring this in favour
			// of POST /v1/tools/search; the tool_calls contract still works.
			return {
				tools: [{ type: 'builtin_function', function: { name: '$web_search' } }],
				passthrough: ['$web_search']
			};
		case 'qwen':
			// OpenAI-compatible mode: no search sources are returned, and their
			// 15 RPS cap silently skips the search instead of erroring.
			return { extraBody: { enable_search: true } };
		case 'openrouter':
			return { extraBody: { plugins: [{ id: 'web' }] } };
		case 'ark':
			// Deliberately unimplemented: Volcengine's 联网内容插件 disables
			// function calling while it is on, which would break every vault tool.
			return null;
		default:
			// deepseek, hunyuan, hermes, custom: no native search.
			return null;
	}
}

/** Decide what search is available for the current mode/provider/settings. */
export function resolveSearch(s: SearchSettings): ResolvedSearch {
	if (s.mode === 'off') return { native: null, tool: false, reason: 'off' };

	const native = s.mode === 'tool' ? null : nativeSearchFor(s.providerId, s.maxResults);
	const hasKey = s.apiKey.trim().length > 0;

	if (s.mode === 'native') return native ? { native, tool: false } : { native: null, tool: false, reason: 'provider-unsupported' };
	if (s.mode === 'tool') return hasKey ? { native: null, tool: true } : { native: null, tool: false, reason: 'no-key' };
	// auto: native when the provider offers it, otherwise the plugin tool.
	if (native) return { native, tool: false };
	return hasKey ? { native: null, tool: true } : { native: null, tool: false, reason: 'no-key' };
}

export function buildWebSearchToolDef(): ToolDef {
	return {
		name: WEB_SEARCH_TOOL_NAME,
		description:
			'Search the live web for current information (news, releases, prices, anything after the model knowledge cut-off) or facts that are not in the vault. Returns titles, URLs and excerpts — cite the URLs you used.',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Search query, as specific as possible' },
				max_results: { type: 'integer', description: 'How many results to return (1-20)' }
			},
			required: ['query']
		}
	};
}

export function buildTavilyBody(query: string, s: SearchSettings, overrideResults?: number): Record<string, unknown> {
	return {
		query: query.trim().slice(0, 400),
		search_depth: s.depth,
		max_results: clampResults(overrideResults ?? s.maxResults),
		// The model reasons over the excerpts itself; a pre-chewed answer only
		// costs tokens and hides the sources.
		include_answer: false
	};
}

/** Turn a Tavily response into text for the model. Never throws. */
export function formatTavilyResults(parsed: unknown): { ok: boolean; content: string } {
	const data = asRecord(parsed);
	if (!data) return { ok: false, content: 'web search failed: unparsable response' };

	const error = errorMessage(data);
	if (error) return { ok: false, content: `web search failed: ${error}` };

	const results = Array.isArray(data.results) ? data.results : [];
	if (!results.length) return { ok: true, content: '(no results)' };

	const blocks = results.map((raw, i) => {
		const item = asRecord(raw) ?? {};
		const title = asString(item.title) || '(untitled)';
		const link = asString(item.url);
		const excerpt = oneLine(asString(item.content)).slice(0, 600);
		return [`${i + 1}. ${title}`, link ? `   ${link}` : '', excerpt ? `   ${excerpt}` : ''].filter(Boolean).join('\n');
	});

	const answer = oneLine(asString(data.answer));
	return { ok: true, content: (answer ? `answer: ${answer}\n\n` : '') + blocks.join('\n') };
}

export function createWebSearchExecutor(post: SearchPost, getSettings: () => SearchSettings): ToolExecutor {
	return {
		async execute(name: string, argsJson: string): Promise<{ ok: boolean; content: string }> {
			if (name !== WEB_SEARCH_TOOL_NAME) return { ok: false, content: `unknown tool: ${name}` };

			const settings = getSettings();
			const apiKey = settings.apiKey.trim();
			if (!apiKey) return { ok: false, content: 'web search is not configured: add a Tavily API key in the plugin settings' };

			let args: Record<string, unknown>;
			try {
				args = asRecord(JSON.parse(argsJson || '{}')) ?? {};
			} catch {
				return { ok: false, content: 'invalid JSON arguments' };
			}
			const query = asString(args.query).trim();
			if (!query) return { ok: false, content: 'web search needs a non-empty query' };
			const override = typeof args.max_results === 'number' ? args.max_results : undefined;

			try {
				const res = await post(
					TAVILY_URL,
					{ 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
					JSON.stringify(buildTavilyBody(query, settings, override))
				);
				if (res.status >= 400) {
					return { ok: false, content: `web search failed: HTTP ${res.status}: ${truncate(res.body, 300)}` };
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(res.body);
				} catch {
					return { ok: false, content: 'web search failed: non-JSON response' };
				}
				return formatTavilyResults(parsed);
			} catch (e: unknown) {
				return { ok: false, content: 'web search failed: ' + (e instanceof Error ? e.message : String(e)) };
			}
		}
	};
}

function clampResults(n: number): number {
	if (!Number.isFinite(n)) return 5;
	return Math.min(20, Math.max(1, Math.round(n)));
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function errorMessage(data: Record<string, unknown>): string {
	if (typeof data.error === 'string') return data.error;
	const detail = asRecord(data.detail);
	if (detail && typeof detail.error === 'string') return detail.error;
	return '';
}
