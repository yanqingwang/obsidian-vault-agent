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
const outProxy = join(dir, 'proxyFetch.mjs');
await Promise.all([
	build({
		entryPoints: [new URL('../agent.ts', import.meta.url).pathname],
		outfile: out,
		bundle: true,
		format: 'esm',
		platform: 'node'
	}),
	build({
		entryPoints: [new URL('../proxyFetch.ts', import.meta.url).pathname],
		outfile: outProxy,
		bundle: true,
		format: 'esm',
		platform: 'node'
	})
]);
const { runAgentLoop, normalizeReasoning } = await import(pathToFileURL(out).href);
const { parseProxy, makeProxyFetch } = await import(pathToFileURL(outProxy).href);

// Node shim so proxyFetch's window.require resolves node modules in tests.
const { createRequire } = await import('node:module');
const nodeReq = createRequire(import.meta.url);
globalThis.window = { require: (id) => nodeReq(id) };

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
// The thinking pane is plain text, so markdown rules must not survive as dash lines.
assert.equal(normalizeReasoning('a\n\n---\n\nb'), 'a\n\nb', 'markdown rule lines are blanked out');
assert.equal(normalizeReasoning('a\n - - - \nb'), 'a\n\nb', 'spaced rules go too');
assert.equal(normalizeReasoning('a\n***\nb'), 'a\n\nb', 'asterisk/underscore rules go too');
assert.equal(normalizeReasoning('a\n- 列表项\nb'), 'a\n- 列表项\nb', 'real bullet lists survive');
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

// 7. Local proxy: request routed through an HTTP forward proxy (absolute-URI).
const forwarded = [];
const proxyServer = http.createServer((req, res) => {
	forwarded.push(req.url);
	const target = new URL(req.url);
	const fwd = http.request(
		{ host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers: { ...req.headers, host: target.host } },
		(r2) => {
			res.writeHead(r2.statusCode, r2.headers);
			r2.pipe(res);
		}
	);
	fwd.on('error', () => { try { res.writeHead(502); res.end(); } catch { } });
	req.pipe(fwd);
});
await new Promise(r => proxyServer.listen(0, '127.0.0.1', r));
const proxyPort = proxyServer.address().port;

// parseProxy unit checks
assert.deepEqual(parseProxy('127.0.0.1:9000'), { host: '127.0.0.1', port: 9000 });
assert.deepEqual(parseProxy('http://127.0.0.1:9000'), { host: '127.0.0.1', port: 9000 });
assert.deepEqual(parseProxy('http://user:secret@10.0.0.8:3128'), { host: '10.0.0.8', port: 3128, auth: 'Basic dXNlcjpzZWNyZXQ=' });
assert.throws(() => parseProxy('socks5://127.0.0.1:1080'), /SOCKS/, 'socks rejected');
assert.throws(() => parseProxy('not a proxy'), /invalid proxy/, 'garbage rejected');

const pf = makeProxyFetch(`http://127.0.0.1:${proxyPort}`);
const proxied = await pf(`http://127.0.0.1:${port}/v1/chat/completions`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' },
	body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
});
assert.equal(proxied.status, 200, 'proxied request reached the target');
assert.ok(forwarded.some(u => u.startsWith(`http://127.0.0.1:${port}/`)), 'proxy saw absolute-URI forward');
// Streaming read through the proxied response body.
const reader = proxied.body.getReader();
const chunks = [];
while (true) {
	const { done, value } = await reader.read();
	if (done) break;
	chunks.push(new TextDecoder().decode(value));
}
const sseBody = chunks.join('');
assert.ok(sseBody.includes('data:'), 'SSE body streamed through the proxy');
assert.ok(sseBody.includes('笔记') || sseBody.includes('tool_calls'), 'proxied SSE payload intact');

// 8. Native web search: vendor body fields and built-in tools reach the request.
{
	seenBodies.length = 0;
	server.removeAllListeners('request');
	server.on('request', (req, res) => {
		let body = '';
		req.on('data', d => body += d);
		req.on('end', () => {
			seenBodies.push(JSON.parse(body));
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			res.end(sse([{ content: 'ok' }, {}]));
		});
	});
	await runAgentLoop({
		baseUrl: `http://127.0.0.1:${port}`,
		apiKey: 'sk-test',
		model: 'test-model',
		messages: [{ role: 'user', content: 'hi' }],
		tools: [{ name: 'read_note', description: 'r', parameters: { type: 'object', properties: {} } }],
		executor,
		fetchImpl: fetch,
		maxIterations: 2,
		nativeSearch: {
			tools: [{ type: 'web_search', web_search: { enable: 'True', count: '5' } }],
			extraBody: { enable_search: true }
		},
		onText: () => {}
	});
	const sent = seenBodies[0];
	assert.equal(sent.enable_search, true, 'extraBody lands in the request body');
	assert.equal(sent.tools.length, 2, 'function tool + native tool');
	assert.ok(sent.tools[0].function, 'vault tool keeps the OpenAI function shape');
	assert.equal(sent.tools[1].type, 'web_search', 'native tool appended raw');
	assert.equal(sent.tools[1].function, undefined, 'native tool must not be wrapped as a function');
}

// 9. The non-streaming fallback keeps the native fields.
{
	let fallbackBody = null;
	const result = await runAgentLoop({
		baseUrl: `http://127.0.0.1:${port}`,
		apiKey: 'sk-test',
		model: 'test-model',
		messages: [{ role: 'user', content: 'hi' }],
		tools: [],
		executor,
		fetchImpl: async () => { throw new Error('CORS'); },
		fallbackPost: async (_url, _headers, body) => {
			fallbackBody = JSON.parse(body);
			return { status: 200, body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'from fallback' } }] }) };
		},
		maxIterations: 2,
		nativeSearch: { extraBody: { enable_search: true } },
		onText: () => {}
	});
	assert.equal(fallbackBody.stream, false, 'fallback is non-streaming');
	assert.equal(fallbackBody.enable_search, true, 'fallback keeps the native field');
	assert.equal(result.text, 'from fallback');
}

// 10. Provider built-in tools are echoed back verbatim, never executed.
{
	seenBodies.length = 0;
	server.removeAllListeners('request');
	let served = 0;
	server.on('request', (req, res) => {
		let body = '';
		req.on('data', d => body += d);
		req.on('end', () => {
			seenBodies.push(JSON.parse(body));
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			served++;
			res.end(served === 1
				? sse([
					{ tool_calls: [{ index: 0, id: 'ws_1', type: 'function', function: { name: '$web_search', arguments: '{"query":"obsidian 0.1.8"}' } }] },
					{}
				])
				: sse([{ content: '搜到了' }, {}]));
		});
	});
	let executedCount = 0;
	const started = [];
	const finished = [];
	const result = await runAgentLoop({
		baseUrl: `http://127.0.0.1:${port}`,
		apiKey: 'sk-test',
		model: 'test-model',
		messages: [{ role: 'user', content: 'hi' }],
		tools: [],
		executor: { async execute() { executedCount++; return { ok: true, content: 'should not happen' }; } },
		passthroughTools: ['$web_search'],
		fetchImpl: fetch,
		maxIterations: 3,
		onText: () => {},
		onToolStart: call => started.push(call.function.name),
		onToolDone: (_call, res2) => finished.push(res2)
	});
	assert.equal(executedCount, 0, 'passthrough never reaches the executor');
	assert.deepEqual(started, ['$web_search'], 'chip callback still fires');
	assert.equal(finished.length, 1);
	assert.equal(
		seenBodies[1].messages.find(m => m.role === 'tool').content,
		'{"query":"obsidian 0.1.8"}',
		'arguments echoed back verbatim (this is what triggers the server-side search)'
	);
	assert.equal(result.text, '搜到了');
}

// 11. A provider that rejects the native field: retry once without it.
{
	seenBodies.length = 0;
	server.removeAllListeners('request');
	let served = 0;
	server.on('request', (req, res) => {
		let body = '';
		req.on('data', d => body += d);
		req.on('end', () => {
			seenBodies.push(JSON.parse(body));
			served++;
			if (served === 1) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: { message: 'unknown field: enable_search' } }));
				return;
			}
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			res.end(sse([{ content: '降级后成功' }, {}]));
		});
	});
	const fallbacks = [];
	const result = await runAgentLoop({
		baseUrl: `http://127.0.0.1:${port}`,
		apiKey: 'sk-test',
		model: 'test-model',
		messages: [{ role: 'user', content: 'hi' }],
		tools: [],
		executor,
		fetchImpl: fetch,
		maxIterations: 2,
		nativeSearch: { extraBody: { enable_search: true } },
		onSearchFallback: detail => fallbacks.push(detail),
		onText: () => {}
	});
	assert.equal(seenBodies.length, 2, 'exactly one retry');
	assert.equal(seenBodies[0].enable_search, true, 'first attempt carried the native field');
	assert.equal(seenBodies[1].enable_search, undefined, 'retry dropped the native field');
	assert.equal(fallbacks.length, 1, 'the downgrade is reported once');
	assert.ok(fallbacks[0].includes('400'), 'reported detail carries the status');
	assert.equal(result.text, '降级后成功', 'the turn still completes');
}

proxyServer.close();
server.close();
console.log('✅ all agent-loop tests passed');
