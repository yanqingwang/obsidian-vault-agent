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

/** One row in the sidebar history panel. */
export interface SessionSummary {
	id: string;
	events: number;
	lastMs: number;
	lastIso: string;
	firstUser: string;
	/** Snippet around the first match; only set when a query was supplied. */
	hit?: string;
}

export interface SessionCursor {
	seq: number;
	turn: number;
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
	private seq: number;
	private turn: number;
	/** Tail of the append chain; keeps lines whole when events arrive rapidly. */
	private pending: Promise<void> = Promise.resolve();

	/**
	 * @param start seq/turn to continue from — pass `sessionCursor()` when
	 * resuming an existing session so numbering does not restart at 1.
	 */
	constructor(
		private readonly adapter: HistoryAppendTarget,
		private readonly path: string,
		readonly sessionId: string,
		private readonly meta: () => HistoryMeta,
		start: SessionCursor = { seq: 0, turn: 0 }
	) {
		this.seq = start.seq;
		this.turn = start.turn;
	}

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

/** Parse a `history.jsonl` body. Blank and torn lines are skipped, not fatal. */
export function parseHistory(text: string): HistoryEvent[] {
	const events: HistoryEvent[] = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			const event = parsed as Partial<HistoryEvent> | null;
			if (event && typeof event === 'object' && typeof event.session === 'string') {
				events.push(event as HistoryEvent);
			}
		} catch {
			// A torn final line from an interrupted append.
		}
	}
	return events;
}

/** One row per session, newest first; with a query, only sessions that match. */
export function summarizeSessions(events: HistoryEvent[], query = ''): SessionSummary[] {
	const needle = query.trim().toLowerCase();
	const bySession = new Map<string, HistoryEvent[]>();
	for (const event of events) {
		const bucket = bySession.get(event.session);
		if (bucket) bucket.push(event);
		else bySession.set(event.session, [event]);
	}

	const out: SessionSummary[] = [];
	for (const [id, bucket] of bySession) {
		const ordered = [...bucket].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
		let hit: string | undefined;
		if (needle) {
			const match = ordered.find(e => eventText(e).toLowerCase().includes(needle));
			if (!match) continue;
			hit = excerpt(eventText(match), needle);
		}
		out.push({
			id,
			events: ordered.length,
			lastMs: ordered.reduce((max, e) => Math.max(max, e.ts ?? 0), 0),
			lastIso: ordered[ordered.length - 1]?.iso ?? '',
			firstUser: firstUserText(ordered),
			hit
		});
	}
	return out.sort((a, b) => b.lastMs - a.lastMs);
}

/** The chat transcript for one session: user/assistant text only, in order. */
export function sessionTranscript(events: HistoryEvent[], sessionId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
	const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
	const ordered = events.filter(e => e.session === sessionId).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
	for (const event of ordered) {
		if ((event.type === 'user' || event.type === 'assistant') && event.content) {
			out.push({ role: event.type === 'user' ? 'user' : 'assistant', content: event.content });
		}
	}
	return out;
}

/** Highest seq/turn used by a session, so a resumed recorder continues counting. */
export function sessionCursor(events: HistoryEvent[], sessionId: string): SessionCursor {
	const cursor: SessionCursor = { seq: 0, turn: 0 };
	for (const event of events) {
		if (event.session !== sessionId) continue;
		cursor.seq = Math.max(cursor.seq, event.seq ?? 0);
		cursor.turn = Math.max(cursor.turn, event.turn ?? 0);
	}
	return cursor;
}

/** One-line window around the first hit, for list previews. */
export function excerpt(text: string, needle: string, width = 90): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	if (!flat) return '';
	const at = flat.toLowerCase().indexOf(needle.toLowerCase());
	if (at < 0) return flat.slice(0, width) + (flat.length > width ? '…' : '');
	const half = Math.floor(width / 2);
	const start = Math.max(0, at - half);
	const end = Math.min(flat.length, at + needle.length + half);
	return (start ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

/** Everything a session's events can be searched by. */
function eventText(event: HistoryEvent): string {
	return [event.content, event.reasoning, event.args, event.tool]
		.filter((value): value is string => typeof value === 'string' && value.length > 0)
		.join('\n');
}

function firstUserText(ordered: HistoryEvent[]): string {
	const first = ordered.find(e => e.type === 'user');
	return (first?.content ?? '').replace(/\s+/g, ' ').trim();
}
