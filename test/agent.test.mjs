/**
 * End-to-end test of the agent loop against a mock OpenAI-compatible SSE server.
 * Runs in Node (agent.ts has no Obsidian dependency).
 */
import assert from 'node:assert';
import http from 'node:http';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 1. Bundle agent.ts to a temp ESM module.
const dir = mkdtempSync(join(tmpdir(), 'va-test-'));
const out = join(dir, 'agent.mjs');
await build({
	entryPoints: [new URL('../agent.ts', import.meta.url).pathname],
	outfile: out,
	bundle: true,
	format: 'esm',
	platform: 'node'
});
const { runAgentLoop, normalizeReasoning } = await import(pathToFileURL(out).href);

// 2. Mock server: turn 1 streams a create_note tool call; turn 2 streams the final answer.
const seenBodies = [];
const sse = (chunks) => {
	const events = [];
	for (const c of chunks) events.push(`data: ${JSON.stringify({ choices: [{ delta: c }] })}\n\n`);
	events.push('data: [DONE]\n\n');
	return events.join('');
};
const server = http.createServer((req, res) => {
	let body = '';
	req.on('data', d => body += d);
	req.on('end', () => {
		seenBodies.push(JSON.parse(body));
		res.writeHead(200, { 'Content-Type': 'text/event-stream' });
		if (seenBodies.length === 1) {
			res.end(sse([
				{ reasoning_content: 'let me ' },
				{ reasoning_content: 'think.\n\n\n\nstep 2:   ' },
				{ content: '我先建个笔记。' },
				{ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'create_note', arguments: '{"path":"Notes/A' } }] },
				{ tool_calls: [{ index: 0, function: { arguments: 'bc.md","content":"# Hello' } }] },
				{ tool_calls: [{ index: 0, function: { arguments: ' world"}' } }] }
			]));
		} else {
			res.end(sse([{ content: '笔记' }, { content: '创建完成 ✅' }, {}]));
		}
	});
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// 3. Fake executor standing in for the vault.
const executed = [];
const executor = {
	async execute(name, argsJson) {
		executed.push({ name, args: JSON.parse(argsJson) });
		return { ok: true, content: `created ${JSON.parse(argsJson).path}` };
	}
};

// 4. Track confirmations (create_note is a write tool).
const confirmations = [];
let denyNext = false;
const confirmWrite = async (summary) => {
	confirmations.push(summary);
	return !denyNext;
};

const messages = [
	{ role: 'system', content: 'sys' },
	{ role: 'user', content: '请创建笔记 Notes/Abc.md' }
];
let streamed = '';
let reasoningStreamed = '';
const { text, hitCap, reasoning } = await runAgentLoop({
	baseUrl: `http://127.0.0.1:${port}`,
	apiKey: 'sk-test',
	model: 'test-model',
	messages,
	tools: [
		{ name: 'create_note', description: 'create', parameters: { type: 'object', properties: {} }, x_write: true },
		{ name: 'noop', description: 'noop', parameters: { type: 'object', properties: {} } }
	],
	executor,
	confirmWrite,
	fetchImpl: fetch,
	maxIterations: 5,
	onText: d => streamed += d,
	onReasoning: d => reasoningStreamed += d
});

// 5. Assertions.
assert.equal(executed.length, 1, 'executor ran once');
assert.deepEqual(executed[0].args, { path: 'Notes/Abc.md', content: '# Hello world' }, 'streamed tool args reassembled');
assert.equal(text, '笔记创建完成 ✅', 'final text is the content, not the reasoning');
assert.equal(reasoningStreamed, 'let me think.\n\n\n\nstep 2:   ', 'reasoning deltas pass through verbatim (no injected newlines)');
assert.equal(reasoning, 'let me think.\n\n\n\nstep 2:   ', 'loop returns reasoning');
assert.equal(normalizeReasoning(reasoningStreamed), 'let me think.\n\nstep 2:', 'normalizeReasoning collapses blank-line runs');
assert.equal(normalizeReasoning('  a \n\n\n\n\n b\n'), 'a\n\nb', 'normalizeReasoning trims edges');
assert.equal(hitCap, false);
assert.equal(confirmations.length, 1, 'write tool asked for confirmation');
assert.ok(streamed.includes('我先建个笔记。'), 'streaming saw deltas');
// Second request must carry the tool result back to the model.
const second = seenBodies[1];
const toolMsg = second.messages.find(m => m.role === 'tool');
assert.ok(toolMsg, 'tool result fed back');
assert.equal(toolMsg.tool_call_id, 'call_1');
assert.ok(second.tools[0].function && !second.tools[0].function.x_write, 'tools sent in OpenAI format without local flags');

// 6. Denial path.
denyNext = true;
server.removeAllListeners('request');
server.on('request', (req, res) => {
	let body = '';
	req.on('data', d => body += d);
	req.on('end', () => {
		seenBodies.push(JSON.parse(body));
		res.writeHead(200, { 'Content-Type': 'text/event-stream' });
		res.end(sse([{ tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'create_note', arguments: '{"path":"x.md","content":"y"}' } }] }, {}]));
	});
});
const messages2 = [{ role: 'user', content: 'again' }];
	await runAgentLoop({
		baseUrl: `http://127.0.0.1:${port}`,
		apiKey: 'sk-test',
		model: 'test-model',
		messages: messages2,
		tools: [{ name: 'create_note', description: 'c', parameters: { type: 'object', properties: {} }, x_write: true }],
		executor,
		confirmWrite,
		fetchImpl: fetch,
		maxIterations: 3,
		onText: () => {}
	});
const deniedMsg = messages2.find(m => m.role === 'tool');
assert.ok(deniedMsg && deniedMsg.content === 'USER_DENIED', 'denial fed back to model');
assert.equal(executed.length, 1, 'executor not called when denied');

server.close();
console.log('✅ all agent-loop tests passed');
