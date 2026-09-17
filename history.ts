/**
 * Append-only JSONL transcript for Vault Agent.
 *
 * The chat view keeps the last 40 messages in `data.json` so it can restore after
 * a restart, but that is a rolling window: no timestamps, no session boundary, no
 * tool calls, nothing to query. This module writes one JSON object per event to
 * `history.jsonl` next to `data.json`; `tools/history_db.py` imports that file
 * into SQLite for full-text search and per-session browsing.
 *
 * The adapter is injected as a two-method interface so the recorder can be
 * unit-tested in Node without Obsidian.
 */

import type { ToolCall } from './agent';

/** The slice of Obsidian's DataAdapter the recorder needs. */
export interface HistoryAppendTarget {
	append(normalizedPath: string, data: string): Promise<void>;
}

export interface HistoryMeta {
	vault?: string;
	provider?: string;
	model?: string;
}

export type HistoryEventType = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'error';

export interface HistoryEvent extends HistoryMeta {
	/** Random per-event id; the SQLite importer dedupes on it. */
	id: string;
	ts: number;
	iso: string;
	session: string;
	/** 1-based position within the session. */
	seq: number;
	/** 1-based user turn; tool events belong to the turn that triggered them. */
	turn: number;
	type: HistoryEventType;
	role: 'user' | 'assistant' | 'tool';
	content?: string;
	reasoning?: string;
	tool?: string;
	callId?: string;
	args?: string;
	ok?: boolean;
	durationMs?: number;
}

export interface ToolResult {
	ok: boolean;
	content: string;
}

export function newSessionId(): string {
	return `${Date.now().toString(36)}-${randomHex(8)}`;
}

function randomHex(length: number): string {
	// `crypto` is a DOM global in Obsidian and a WebCrypto global in Node >= 20,
	// so the same code path works in the plugin and in the Node unit test.
	const webCrypto = typeof crypto !== 'undefined' ? crypto : null;
	if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
		const bytes = new Uint8Array(Math.ceil(length / 2));
		webCrypto.getRandomValues(bytes);
		return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').slice(0, length);
	}
	let out = '';
	for (let i = 0; i < length; i++) out += Math.floor(Math.random() * 16).toString(16);
	return out;
}

export class HistoryRecorder {
	private seq = 0;
	private turn = 0;
	/** Tail of the append chain; keeps lines whole when events arrive rapidly. */
	private pending: Promise<void> = Promise.resolve();

	constructor(
		private readonly adapter: HistoryAppendTarget,
		private readonly path: string,
		readonly sessionId: string,
		private readonly meta: () => HistoryMeta
	) {}

	user(text: string): void {
		this.turn++;
		this.write({ type: 'user', role: 'user', content: text });
	}

	assistant(text: string, reasoning: string): void {
		this.write({ type: 'assistant', role: 'assistant', content: text, reasoning: reasoning || undefined });
	}

	toolCall(call: ToolCall): void {
		this.write({
			type: 'tool_call',
			role: 'tool',
			tool: call.function.name,
			callId: call.id,
			args: call.function.arguments
		});
	}

	toolResult(call: ToolCall, result: ToolResult, durationMs: number): void {
		this.write({
			type: 'tool_result',
			role: 'tool',
			tool: call.function.name,
			callId: call.id,
			ok: result.ok,
			content: result.content,
			durationMs: Math.max(0, Math.round(durationMs))
		});
	}

	error(message: string): void {
		this.write({ type: 'error', role: 'assistant', content: message });
	}

	/** Resolves once every queued line has been handed to the adapter. */
	flush(): Promise<void> {
		return this.pending;
	}

	/**
	 * Appends are chained rather than fired in parallel: two overlapping
	 * `append` calls could otherwise interleave and corrupt a JSONL line.
	 * Logging must never break the chat, so failures are swallowed.
	 */
	private write(partial: Partial<HistoryEvent> & Pick<HistoryEvent, 'type' | 'role'>): void {
		this.seq++;
		const event: HistoryEvent = {
			...this.meta(),
			id: randomHex(16),
			ts: Date.now(),
			iso: new Date().toISOString(),
			session: this.sessionId,
			seq: this.seq,
			turn: this.turn,
			...partial
		};
		const line = JSON.stringify(event) + '\n';
		this.pending = this.pending.then(() => this.adapter.append(this.path, line)).catch(() => undefined);
	}
}
