/**
 * Unit test for the JSONL transcript recorder (history.ts).
 * Runs in Node against a fake append target, so no Obsidian is needed.
 */
import assert from 'node:assert';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'va-history-'));
const out = join(dir, 'history.mjs');
await build({
	entryPoints: [new URL('../history.ts', import.meta.url).pathname],
	outfile: out,
	bundle: true,
	format: 'esm',
	platform: 'node'
});
const { HistoryRecorder, newSessionId, parseHistory, summarizeSessions, sessionTranscript, sessionCursor, excerpt } =
	await import(pathToFileURL(out).href);

/** Collects appended chunks; a small delay makes interleaving detectable. */
function fakeAdapter() {
	const chunks = [];
	return {
		chunks,
		async append(path, data) {
			await new Promise(r => setTimeout(r, 1));
			chunks.push(data);
		}
	};
}

const call = { id: 'call_1', type: 'function', function: { name: 'read_note', arguments: '{"path":"A.md"}' } };

// --- 1. event schema and ordering -------------------------------------------
{
	const adapter = fakeAdapter();
	const rec = new HistoryRecorder(adapter, '.obsidian/plugins/vault-agent/history.jsonl', 'sess-a', () => ({
		vault: 'wk',
		provider: 'deepseek',
		model: 'deepseek-chat'
	}));

	rec.user('帮我整理笔记');
	rec.toolCall(call);
	rec.toolResult(call, { ok: true, content: '# A' }, 42.6);
	rec.assistant('已整理完成', '先读再改');
	rec.error('HTTP 500');
	rec.user('再来一次');
	await rec.flush();

	assert.equal(adapter.chunks.length, 6, 'one append per event');
	// Chained appends must never split or interleave a line.
	for (const chunk of adapter.chunks) {
		assert.ok(chunk.endsWith('\n'), 'each chunk is a complete line');
		assert.equal(chunk.trimEnd().split('\n').length, 1, 'no embedded newline');
	}

	const events = adapter.chunks.map(c => JSON.parse(c));
	assert.deepEqual(
		events.map(e => e.type),
		['user', 'tool_call', 'tool_result', 'assistant', 'error', 'user']
	);
	assert.deepEqual(events.map(e => e.seq), [1, 2, 3, 4, 5, 6]);
	assert.deepEqual(events.map(e => e.turn), [1, 1, 1, 1, 1, 2]);
	assert.deepEqual(events.map(e => e.session), new Array(6).fill('sess-a'));

	const ids = new Set(events.map(e => e.id));
	assert.equal(ids.size, 6, 'event ids are unique');

	for (const e of events) {
		assert.equal(e.vault, 'wk');
		assert.equal(e.provider, 'deepseek');
		assert.equal(e.model, 'deepseek-chat');
		assert.equal(typeof e.ts, 'number');
		assert.ok(!Number.isNaN(Date.parse(e.iso)), 'iso is a parseable timestamp');
	}

	const [user, toolCallEvent, toolResultEvent, assistant, error] = events;
	assert.equal(user.role, 'user');
	assert.equal(user.content, '帮我整理笔记');
	assert.equal(user.reasoning, undefined);

	assert.equal(toolCallEvent.role, 'tool');
	assert.equal(toolCallEvent.tool, 'read_note');
	assert.equal(toolCallEvent.callId, 'call_1');
	assert.equal(toolCallEvent.args, '{"path":"A.md"}');

	assert.equal(toolResultEvent.ok, true);
	assert.equal(toolResultEvent.content, '# A');
	assert.equal(toolResultEvent.durationMs, 43, 'duration is rounded');

	assert.equal(assistant.reasoning, '先读再改');
	assert.equal(assistant.content, '已整理完成');
	// Empty reasoning is omitted rather than written as "".
	rec.assistant('no reasoning', '');
	await rec.flush();
	const last = JSON.parse(adapter.chunks[adapter.chunks.length - 1]);
	assert.equal(last.reasoning, undefined);
	assert.equal(error.type, 'error');
	assert.equal(error.role, 'assistant');
}

// --- 2. flush waits for every queued append ---------------------------------
{
	const adapter = fakeAdapter();
	const rec = new HistoryRecorder(adapter, 'history.jsonl', 'sess-b', () => ({}));
	for (let i = 0; i < 25; i++) rec.user(`msg ${i}`);
	assert.equal(adapter.chunks.length, 0, 'appends are queued, not synchronous');
	await rec.flush();
	assert.equal(adapter.chunks.length, 25);
	assert.deepEqual(
		adapter.chunks.map(c => JSON.parse(c).seq),
		Array.from({ length: 25 }, (_, i) => i + 1)
	);
}

// --- 3. append failures never reject ----------------------------------------
{
	const rec = new HistoryRecorder(
		{ async append() { throw new Error('disk full'); } },
		'history.jsonl',
		'sess-c',
		() => ({})
	);
	rec.user('still fine');
	await rec.flush();
	rec.assistant('and still usable', '');
	await rec.flush();
}

// --- 5. parse + summarize for the sidebar panel ------------------------------
const transcript = [
	{ id: 'a1', ts: 1000, iso: '2026-09-17T01:00:00.000Z', session: 's-old', seq: 1, turn: 1, type: 'user', role: 'user', content: '帮我整理 nextcloud 同步的笔记' },
	{ id: 'a2', ts: 1100, iso: '2026-09-17T01:00:00.100Z', session: 's-old', seq: 2, turn: 1, type: 'assistant', role: 'assistant', content: '找到 1 条：Notes/sync.md' },
	{ id: 'b1', ts: 5000, iso: '2026-09-17T01:01:00.000Z', session: 's-new', seq: 1, turn: 1, type: 'user', role: 'user', content: '把当前笔记结尾改成总结' },
	{ id: 'b2', ts: 5200, iso: '2026-09-17T01:01:00.200Z', session: 's-new', seq: 2, turn: 1, type: 'tool_call', role: 'tool', tool: 'edit_note', args: '{"path":"Draft/plan.md"}' },
	{ id: 'b3', ts: 5400, iso: '2026-09-17T01:01:00.400Z', session: 's-new', seq: 3, turn: 1, type: 'tool_result', role: 'tool', tool: 'edit_note', ok: true, content: 'edited Draft/plan.md' },
	{ id: 'b4', ts: 5600, iso: '2026-09-17T01:01:00.600Z', session: 's-new', seq: 4, turn: 1, type: 'assistant', role: 'assistant', content: '已改好。' }
];

// Torn last line (interrupted append) and a blank line must not break parsing.
const raw = transcript.map(e => JSON.stringify(e)).join('\n') + '\n\n{"id":"torn","session":"s-new","seq"\n';
const parsed = parseHistory(raw);
assert.equal(parsed.length, 6, 'torn trailing line is skipped, blank lines ignored');
assert.deepEqual(parseHistory('').length, 0);
assert.deepEqual(parseHistory('not json\n').length, 0);

const sessions = summarizeSessions(parsed);
assert.deepEqual(sessions.map(s => s.id), ['s-new', 's-old'], 'newest first');
assert.equal(sessions[0].events, 4);
assert.equal(sessions[0].firstUser, '把当前笔记结尾改成总结');
assert.equal(sessions[0].lastMs, 5600);
assert.equal(sessions[0].hit, undefined, 'no query means no hit snippet');

const filtered = summarizeSessions(parsed, 'NEXTCLOUD');
assert.deepEqual(filtered.map(s => s.id), ['s-old'], 'query is case-insensitive');
assert.ok(filtered[0].hit.includes('nextcloud'), 'hit snippet carries the match');

// Tool args are searchable too, so "which notes did it edit" is answerable.
assert.deepEqual(summarizeSessions(parsed, 'Draft/plan.md').map(s => s.id), ['s-new']);
assert.deepEqual(summarizeSessions(parsed, 'read_note').length, 0);

assert.deepEqual(sessionTranscript(parsed, 's-new'), [
	{ role: 'user', content: '把当前笔记结尾改成总结' },
	{ role: 'assistant', content: '已改好。' }
], 'transcript keeps text turns only, in seq order');
assert.deepEqual(sessionTranscript(parsed, 'nope'), []);

assert.deepEqual(sessionCursor(parsed, 's-new'), { seq: 4, turn: 1 });
assert.deepEqual(sessionCursor(parsed, 'nope'), { seq: 0, turn: 0 });

assert.equal(excerpt('前面很长的一段说明后面才是关键词后面还有结尾', '关键词', 10).includes('关键词'), true);
assert.equal(excerpt('', 'x'), '');

// --- 6. a resumed session continues numbering --------------------------------
{
	const adapter = fakeAdapter();
	const cursor = sessionCursor(parsed, 's-new');
	const rec = new HistoryRecorder(adapter, 'history.jsonl', 's-new', () => ({}), cursor);
	rec.user('接着聊');
	rec.assistant('好', '');
	await rec.flush();
	const [user, assistant] = adapter.chunks.map(c => JSON.parse(c));
	assert.equal(user.seq, 5, 'seq continues after the last stored event');
	assert.equal(user.turn, 2, 'turn continues too');
	assert.equal(assistant.seq, 6);
	assert.equal(assistant.session, 's-new', 'events land in the resumed session');
}

// --- 7. session ids ----------------------------------------------------------
{
	const ids = new Set(Array.from({ length: 50 }, () => newSessionId()));
	assert.equal(ids.size, 50);
	for (const id of ids) assert.match(id, /^[0-9a-z]+-[0-9a-f]{8}$/);
}

console.log('history.test.mjs: all assertions passed');
