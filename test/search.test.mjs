/**
 * Unit tests for search.ts: provider mapping, mode resolution, Tavily request
 * shaping and response formatting, plus the executor against a mock HTTP server.
 * Runs in Node (search.ts has no Obsidian dependency).
 */
import assert from 'node:assert';
import http from 'node:http';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'va-search-'));
const out = join(dir, 'search.mjs');
const outAgent = join(dir, 'agent.mjs');
await Promise.all([
	build({
		entryPoints: [new URL('../search.ts', import.meta.url).pathname],
		outfile: out,
		bundle: true,
		format: 'esm',
		platform: 'node'
	}),
	build({
		entryPoints: [new URL('../agent.ts', import.meta.url).pathname],
		outfile: outAgent,
		bundle: true,
		format: 'esm',
		platform: 'node'
	})
]);
const {
	nativeSearchFor,
	resolveSearch,
	buildWebSearchToolDef,
	buildTavilyBody,
	formatTavilyResults,
	createWebSearchExecutor,
	WEB_SEARCH_TOOL_NAME,
	TAVILY_URL
} = await import(pathToFileURL(out).href);
const { runAgentLoop } = await import(pathToFileURL(outAgent).href);

// --- 1. provider-native mapping ---------------------------------------------
assert.equal(nativeSearchFor('deepseek', 5), null, 'deepseek has no native search');
assert.equal(nativeSearchFor('ark', 5), null, 'ark is unusable: its search plugin disables function calling');
assert.equal(nativeSearchFor('hunyuan', 5), null);
assert.equal(nativeSearchFor('hermes', 5), null);
assert.equal(nativeSearchFor('custom', 5), null);
assert.equal(nativeSearchFor('nonsense', 5), null, 'unknown providers must not crash');

const glm = nativeSearchFor('glm', 7);
assert.equal(glm.tools[0].type, 'web_search');
assert.equal(glm.tools[0].web_search.count, '7', 'vendor example uses string values');
assert.equal(glm.extraBody, undefined);
assert.equal(glm.passthrough, undefined);
assert.equal(nativeSearchFor('zai', 3).tools[0].type, 'web_search', 'zai mirrors glm');
assert.equal(nativeSearchFor('glm', 999).tools[0].web_search.count, '20', 'count clamped to 20');
assert.equal(nativeSearchFor('glm', 0).tools[0].web_search.count, '1', 'count clamped up to 1');

const kimi = nativeSearchFor('kimi', 5);
assert.equal(kimi.tools[0].type, 'builtin_function');
assert.equal(kimi.tools[0].function.name, '$web_search');
assert.deepEqual(kimi.passthrough, ['$web_search'], 'client must echo the arguments back');

assert.deepEqual(nativeSearchFor('qwen', 5).extraBody, { enable_search: true });
assert.deepEqual(nativeSearchFor('openrouter', 5).extraBody, { plugins: [{ id: 'web' }] });
assert.equal(nativeSearchFor('qwen', 5).tools, undefined, 'qwen uses a body field, not a tool');

// --- 2. mode resolution ------------------------------------------------------
const base = { providerId: 'deepseek', apiKey: '', maxResults: 5, depth: 'basic' };

assert.deepEqual(resolveSearch({ ...base, mode: 'off' }), { native: null, tool: false, reason: 'off' });

assert.deepEqual(resolveSearch({ ...base, mode: 'tool' }), { native: null, tool: false, reason: 'no-key' });
assert.equal(resolveSearch({ ...base, mode: 'tool', apiKey: 'tvly-x' }).tool, true);
assert.equal(resolveSearch({ ...base, mode: 'tool', apiKey: '   ' }).tool, false, 'blank key counts as no key');

const autoGlm = resolveSearch({ ...base, mode: 'auto', providerId: 'glm' });
assert.ok(autoGlm.native && !autoGlm.tool, 'auto prefers native when the provider has it');

const autoDeepseek = resolveSearch({ ...base, mode: 'auto', apiKey: 'tvly-x' });
assert.ok(!autoDeepseek.native && autoDeepseek.tool, 'auto falls back to the tool');

assert.deepEqual(resolveSearch({ ...base, mode: 'auto' }), { native: null, tool: false, reason: 'no-key' });

assert.deepEqual(resolveSearch({ ...base, mode: 'native' }), { native: null, tool: false, reason: 'provider-unsupported' });
assert.equal(resolveSearch({ ...base, mode: 'native', apiKey: 'tvly-x' }).tool, false, 'native mode never exposes the tool');
assert.ok(resolveSearch({ ...base, mode: 'native', providerId: 'kimi' }).native, 'kimi supports native');

// --- 3. tool definition and request body ------------------------------------
const def = buildWebSearchToolDef();
assert.equal(def.name, 'web_search');
assert.deepEqual(def.parameters.required, ['query']);
assert.equal(def.x_write, undefined, 'search never needs write confirmation');

const longQuery = buildTavilyBody('x'.repeat(500), { ...base, maxResults: 50, depth: 'advanced' });
assert.equal(longQuery.query.length, 400, 'query truncated');
assert.equal(longQuery.max_results, 20, 'results clamped to 20');
assert.equal(longQuery.search_depth, 'advanced');
assert.equal(longQuery.include_answer, false, 'the model reasons over excerpts itself');
assert.equal(buildTavilyBody('q', { ...base, maxResults: 0 }).max_results, 1);

// --- 4. response formatting --------------------------------------------------
const formatted = formatTavilyResults({
	results: [{ title: 'Obsidian 0.1.8', url: 'https://obsidian.md', content: 'line1\n\nline2' }]
});
assert.equal(formatted.ok, true);
assert.ok(formatted.content.includes('1. Obsidian 0.1.8'));
assert.ok(formatted.content.includes('https://obsidian.md'));
assert.ok(formatted.content.includes('line1 line2'), 'excerpts collapse to one line');

assert.deepEqual(formatTavilyResults({ results: [] }), { ok: true, content: '(no results)' });
assert.equal(formatTavilyResults('not an object').ok, false, 'non-object body is an error');
assert.equal(formatTavilyResults({ error: 'bad key' }).content, 'web search failed: bad key');
assert.equal(
	formatTavilyResults({ detail: { error: 'Unauthorized: missing or invalid API key.' } }).content,
	'web search failed: Unauthorized: missing or invalid API key.',
	'real Tavily 401 body shape'
);
assert.ok(
	formatTavilyResults({ answer: 'because', results: [{ title: 'T', url: 'u', content: 'c' }] }).content.startsWith('answer: because')
);

// --- 5. executor against a mock server --------------------------------------
const seen = [];
const server = http.createServer((req, res) => {
	let body = '';
	req.on('data', d => body += d);
	req.on('end', () => {
		seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
		if (req.headers.authorization !== 'Bearer tvly-good') {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ detail: { error: 'Unauthorized: missing or invalid API key.' } }));
			return;
		}
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ results: [{ title: 'Obsidian 0.1.8', url: 'https://obsidian.md', content: 'release notes' }] }));
	});
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let requestedUrl = '';
const post = (url, headers, body) => {
	requestedUrl = url;
	return fetch(`http://127.0.0.1:${port}/search`, { method: 'POST', headers, body })
		.then(async r => ({ status: r.status, body: await r.text() }));
};

const settings = { mode: 'tool', providerId: 'deepseek', apiKey: 'tvly-good', maxResults: 3, depth: 'basic' };
const exec = createWebSearchExecutor(post, () => settings);

const found = await exec.execute(WEB_SEARCH_TOOL_NAME, JSON.stringify({ query: 'obsidian 0.1.8 发布' }));
assert.equal(found.ok, true);
assert.ok(found.content.includes('https://obsidian.md'));
assert.equal(requestedUrl, TAVILY_URL, 'executor targets the documented endpoint');
assert.equal(seen[0].auth, 'Bearer tvly-good');
assert.equal(seen[0].body.query, 'obsidian 0.1.8 发布');
assert.equal(seen[0].body.max_results, 3, 'setting is used');

await exec.execute(WEB_SEARCH_TOOL_NAME, JSON.stringify({ query: 'x', max_results: 99 }));
assert.equal(seen[1].body.max_results, 20, 'tool argument overrides the setting, still clamped');

assert.equal((await exec.execute(WEB_SEARCH_TOOL_NAME, '{}')).ok, false, 'empty query rejected');
assert.equal((await exec.execute(WEB_SEARCH_TOOL_NAME, 'not json')).ok, false, 'bad JSON rejected');
assert.equal((await exec.execute('read_note', '{}')).ok, false, 'other tool names belong to the vault executor');

const bad = await createWebSearchExecutor(post, () => ({ ...settings, apiKey: 'tvly-bad' }))
	.execute(WEB_SEARCH_TOOL_NAME, JSON.stringify({ query: 'x' }));
assert.equal(bad.ok, false);
assert.ok(bad.content.includes('401'), 'HTTP status surfaced');
assert.ok(bad.content.includes('Unauthorized'), 'vendor message surfaced');

const noKey = await createWebSearchExecutor(post, () => ({ ...settings, apiKey: '   ' }))
	.execute(WEB_SEARCH_TOOL_NAME, JSON.stringify({ query: 'x' }));
assert.ok(noKey.content.includes('not configured'), 'missing key is explained, not thrown');

// --- 6. end-to-end wiring: model → web_search → Tavily → model ---------------
// view.ts builds this composition and cannot be unit-tested, so replicate it
// here: the tool name the model calls must be the name the executor routes on.
{
	const sse = (chunks) => chunks.map(c => `data: ${JSON.stringify({ choices: [{ delta: c }] })}\n\n`).join('') + 'data: [DONE]\n\n';
	let llmCalls = 0;
	const llmBodies = [];
	const llm = http.createServer((req, res) => {
		let body = '';
		req.on('data', d => body += d);
		req.on('end', () => {
			llmBodies.push(JSON.parse(body));
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			llmCalls++;
			res.end(llmCalls === 1
				? sse([
					{ content: '我查一下。' },
					{ tool_calls: [{ index: 0, id: 'c_search', type: 'function', function: { name: WEB_SEARCH_TOOL_NAME, arguments: '{"query":"obsidian 0.1.8"}' } }] },
					{}
				])
				: sse([{ content: '0.1.8 加了历史面板。' }, {}]));
		});
	});
	await new Promise(r => llm.listen(0, '127.0.0.1', r));

	const vaultExecutor = { async execute() { return { ok: false, content: 'vault tool should not run here' }; } };
	const searchExecutor = createWebSearchExecutor(post, () => settings);
	const executor = {
		execute: (name, args) => name === WEB_SEARCH_TOOL_NAME
			? searchExecutor.execute(name, args)
			: vaultExecutor.execute(name, args)
	};

	const chips = [];
	const out2 = await runAgentLoop({
		baseUrl: `http://127.0.0.1:${llm.address().port}`,
		apiKey: 'sk-test',
		model: 'test-model',
		messages: [{ role: 'user', content: '0.1.8 有什么新东西？' }],
		tools: [buildWebSearchToolDef()],
		executor,
		fetchImpl: fetch,
		maxIterations: 4,
		onText: () => {},
		onToolStart: c => chips.push(c.function.name),
		onToolDone: (_c, r) => chips.push(r.ok ? 'ok' : 'failed')
	});

	assert.deepEqual(chips, [WEB_SEARCH_TOOL_NAME, 'ok'], 'the search ran through the routed executor');
	assert.equal(out2.text, '0.1.8 加了历史面板。', 'the model answers after seeing the results');
	const toolMessage = llmBodies[1].messages.find(m => m.role === 'tool');
	assert.ok(toolMessage.content.includes('https://obsidian.md'), 'Tavily results were fed back to the model');
	assert.equal(llmBodies[0].tools[0].function.name, WEB_SEARCH_TOOL_NAME, 'tool advertised to the model');
	llm.close();
}

server.close();
console.log('search.test.mjs: all assertions passed');
