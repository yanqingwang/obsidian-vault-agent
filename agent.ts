/**
 * OpenAI-compatible chat client with streaming (SSE) and an agentic tool-call loop.
 * Framework-free so it can be unit-tested in Node with a mock server.
 */

import type { FetchLike } from './proxyFetch';

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

export interface ToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export interface ToolDef {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	/** Local-only flag: tool mutates the vault and may need user confirmation. Not sent to the API. */
	x_write?: boolean;
}

/** Provider-native web search: extra request-body fields and built-in tools. */
export interface NativeSearchRequest {
	/** Raw entries appended to the body's `tools` array (not wrapped as functions). */
	tools?: unknown[];
	/** Top-level body fields, e.g. `enable_search` or `plugins`. */
	extraBody?: Record<string, unknown>;
}

export interface ChatRequestConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	temperature?: number;
	maxTokens?: number;
	nativeSearch?: NativeSearchRequest;
}

export interface StreamHandlers {
	onText?: (delta: string) => void;
	onReasoning?: (delta: string) => void;
	onToolCallDelta?: (toolCalls: ToolCall[]) => void;
	signal?: AbortSignal;
	/** Platform fetch implementation (window.fetch in the plugin; injected fetch in Node tests), or a proxy-fetch. */
	fetchImpl?: FetchLike;
	/** Optional non-streaming fallback (e.g. Obsidian requestUrl to bypass CORS). */
	fallbackPost?: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>;
	/** Called when the provider rejected the native search declaration and we retried without it. */
	onSearchFallback?: (detail: string) => void;
}

interface AssistantTurn {
	content: string | null;
	reasoning: string | null;
	toolCalls: ToolCall[];
}

/** One round-trip against /chat/completions. Streams if possible, falls back to non-streaming. */
export async function chatCompletion(cfg: ChatRequestConfig, messages: ChatMessage[], tools: ToolDef[], h: StreamHandlers): Promise<AssistantTurn> {
	const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Authorization: 'Bearer ' + cfg.apiKey
	};
	const fnTools = tools.length
		? tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
		: [];
	const nativeTools = cfg.nativeSearch?.tools ?? [];
	// Native declarations are vendor-specific: an unknown body field or tool type
	// can make a provider reject the whole request, so the caller retries once
	// with `withNative: false` before giving up on the turn.
	let withNative = nativeTools.length > 0 || cfg.nativeSearch?.extraBody !== undefined;
	const buildPayload = (include: boolean): Record<string, unknown> => {
		const allTools = include ? [...fnTools, ...nativeTools] : fnTools;
		return {
			// Spread first so vendor extras can never clobber model/messages.
			...(include ? cfg.nativeSearch?.extraBody ?? {} : {}),
			model: cfg.model,
			messages,
			temperature: cfg.temperature ?? 0.7,
			max_tokens: cfg.maxTokens ?? 8192,
			stream: true,
			tools: allTools.length ? allTools : undefined
		};
	};

	const turn: AssistantTurn = { content: null, reasoning: null, toolCalls: [] };
	const sendStream = async (): Promise<void> => {
		// Obsidian's requestUrl cannot stream responses, so streaming goes through the
		// platform fetch implementation injected by the host (window.fetch in the plugin).
		if (!h.fetchImpl) throw new Error('no streaming fetch implementation provided');
		const res = await h.fetchImpl(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(buildPayload(withNative)),
			signal: h.signal
		});
		if (!res.ok) {
			const errText = await res.text().catch(() => '');
			throw new Error(`HTTP ${res.status}: ${truncate(errText, 500)}`);
		}
		if (!res.body) throw new Error('empty response body');
		await consumeSse(res.body, (data) => applyChunk(data, turn, h));
	};

	try {
		try {
			await sendStream();
		} catch (e: unknown) {
			// A provider that rejects our native search declaration (unknown field or
			// tool type) must not cost the user the whole turn: drop it and retry once.
			const message = e instanceof Error ? e.message : String(e);
			const idle = turn.content === null && turn.toolCalls.length === 0;
			const rejected = /^HTTP (400|404|422)\b/.test(message);
			if (!withNative || !rejected || !idle || h.signal?.aborted) throw e;
			withNative = false;
			h.onSearchFallback?.(message);
			await sendStream();
		}
	} catch (e: unknown) {
		// Network/CORS/unsupported-stream failures: retry once without streaming.
		if (h.fallbackPost && !(h.signal?.aborted)) {
			const out = await h.fallbackPost(url, headers, JSON.stringify({ ...buildPayload(withNative), stream: false }));
			if (out.status >= 400) throw new Error(`HTTP ${out.status}: ${truncate(out.body, 500)}`);
			applyChunk(out.body || '{}', turn, h, true);
		} else {
			throw e;
		}
	}
	return turn;
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function applyChunk(payload: string, turn: AssistantTurn, h: StreamHandlers, nonStream = false): void {
	if (!payload || payload === '[DONE]') return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return;
	}
	const data = asRecord(parsed);
	if (!data) return;
	const choices = Array.isArray(data.choices) ? data.choices : [];
	const choice = asRecord(choices[0]);
	if (!choice) return;
	const raw = nonStream ? choice.message : choice.delta;
	const delta = asRecord(raw) ?? {};
	const content = delta.content;
	if (typeof content === 'string' && content.length) {
		turn.content = (turn.content ?? '') + content;
		h.onText?.(content);
	}
	const reasoning = delta.reasoning_content;
	if (typeof reasoning === 'string' && reasoning.length) {
		turn.reasoning = (turn.reasoning ?? '') + reasoning;
		h.onReasoning?.(reasoning);
	}
	const toolCallsRaw = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
	if (toolCallsRaw.length) {
		for (const rawTc of toolCallsRaw) {
			const tc = asRecord(rawTc);
			if (!tc) continue;
			const fn = asRecord(tc.function);
			const idx = typeof tc.index === 'number' ? tc.index : 0;
			let target = turn.toolCalls[idx];
			if (!target) {
				target = {
					id: typeof tc.id === 'string' ? tc.id : '',
					type: 'function',
					function: { name: typeof fn?.name === 'string' ? fn.name : '', arguments: '' }
				};
				turn.toolCalls[idx] = target;
			}
			if (typeof tc.id === 'string' && tc.id) target.id = tc.id;
			if (typeof fn?.name === 'string' && fn.name) target.function.name = fn.name;
			if (typeof fn?.arguments === 'string') target.function.arguments += fn.arguments;
		}
		h.onToolCallDelta?.(turn.toolCalls.filter(Boolean));
	}
}

/** Read an SSE body stream, invoking cb for every `data:` payload. */
export async function consumeSse(body: ReadableStream<Uint8Array>, cb: (payload: string) => void): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		let nl: number;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl).replace(/\r$/, '');
			buf = buf.slice(nl + 1);
			if (line.startsWith('data:')) cb(line.slice(5).trim());
		}
	}
	const rest = buf.trim();
	if (rest.startsWith('data:')) cb(rest.slice(5).trim());
}

export interface ToolExecutor {
	execute(name: string, argsJson: string): Promise<{ ok: boolean; content: string; confirmHint?: string }>;
}

export interface AgentLoopOptions extends ChatRequestConfig {
	messages: ChatMessage[];
	tools: ToolDef[];
	executor: ToolExecutor;
	maxIterations?: number;
	confirmWrite?: (summary: string) => Promise<boolean>;
	onText?: (delta: string) => void;
	onReasoning?: (delta: string) => void;
	onToolStart?: (call: ToolCall) => void;
	onToolDone?: (call: ToolCall, result: { ok: boolean; content: string }) => void;
	/** Provider built-in tools (e.g. Kimi's `$web_search`) whose arguments are echoed back, not executed. */
	passthroughTools?: string[];
	onSearchFallback?: (detail: string) => void;
	signal?: AbortSignal;
	fetchImpl?: FetchLike;
	fallbackPost?: StreamHandlers['fallbackPost'];
}

export interface AgentLoopResult {
	text: string;
	reasoning: string;
	hitCap: boolean;
}

/**
 * Agentic loop: chat → (tool calls → execute → feed results) → repeat → final text.
 * Returns the final assistant text (empty if the loop hit its iteration cap mid-flight).
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
	const maxIter = opts.maxIterations ?? 12;
	let hitCap = false;
	let reasoning = '';
	for (let i = 0; i < maxIter; i++) {
		const turn = await chatCompletion(opts, opts.messages, opts.tools, {
			onText: opts.onText,
			onReasoning: opts.onReasoning,
			onSearchFallback: opts.onSearchFallback,
			signal: opts.signal,
			fetchImpl: opts.fetchImpl,
			fallbackPost: opts.fallbackPost
		});
		if (turn.reasoning) reasoning += (reasoning ? '\n' : '') + turn.reasoning;
		const calls = turn.toolCalls.filter(Boolean);
		if (!calls.length) {
			return { text: turn.content ?? '', reasoning, hitCap: false };
		}
		opts.messages.push({
			role: 'assistant',
			content: turn.content ?? null,
			tool_calls: calls
		});
		for (const call of calls) {
			opts.onToolStart?.(call);
			let result = { ok: false, content: 'blocked before execution' };
			try {
				if (opts.passthroughTools?.includes(call.function.name)) {
					// Vendor built-in (e.g. Kimi's $web_search): echoing the arguments
					// back verbatim is what makes the server run the search. Nothing is
					// parsed or executed here, and the chip/history callbacks still fire.
					result = { ok: true, content: call.function.arguments || '{}' };
				} else {
					const args: unknown = JSON.parse(call.function.arguments || '{}');
					// Write actions may require explicit user confirmation.
					const def = opts.tools.find(t => t.name === call.function.name);
					if (def?.x_write && opts.confirmWrite && !(await opts.confirmWrite(`${call.function.name}: ${truncate(JSON.stringify(args), 200)}`))) {
						result = { ok: false, content: 'USER_DENIED' };
					} else {
						result = await opts.executor.execute(call.function.name, call.function.arguments);
					}
				}
			} catch (e: unknown) {
				result = { ok: false, content: 'tool error: ' + (e instanceof Error ? e.message : String(e)) };
			}
			opts.onToolDone?.(call, result);
			opts.messages.push({
				role: 'tool',
				tool_call_id: call.id,
				content: truncate(result.content, 20000)
			});
		}
		hitCap = true; // stays true only if we exhaust the loop below
	}
	return { text: '', reasoning: '', hitCap };
}

export function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return s.slice(0, n) + `… [truncated, ${s.length} chars total]`;
}

/**
 * Normalize streamed reasoning text for display: reasoning models emit lots of
 * stray whitespace and long runs of blank lines; collapse them without losing
 * paragraph structure.
 */
export function normalizeReasoning(text: string): string {
	return text
		.replace(/\r\n?/g, '\n')
		.replace(/[ \t]+/g, ' ')
		.replace(/ ?\n ?/g, '\n')
		// The thinking pane renders plain text, so a markdown rule (`---`) shows up
		// as a literal line of dashes. Blank it out; the run collapses just below.
		.replace(/^([-*_]) *(?:\1 *){2,}$/gm, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}
