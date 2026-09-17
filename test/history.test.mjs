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
const { HistoryRecorder, newSessionId } = await import(pathToFileURL(out).href);

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

// --- 4. session ids ----------------------------------------------------------
{
	const ids = new Set(Array.from({ length: 50 }, () => newSessionId()));
	assert.equal(ids.size, 50);
	for (const id of ids) assert.match(id, /^[0-9a-z]+-[0-9a-f]{8}$/);
}

console.log('history.test.mjs: all assertions passed');
