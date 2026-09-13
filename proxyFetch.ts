/**
 * Desktop-only HTTP-proxy fetch: routes requests through an HTTP proxy —
 * absolute-URI forwarding for http targets, CONNECT tunneling for https targets.
 * No obsidian import so it stays testable in Node; Node modules are reached
 * through `window.require` (Obsidian desktop renderer) and fall back to the
 * ambient `require` in Node test runs.
 */

export interface FetchLikeResponse {
	ok: boolean;
	status: number;
	text(): Promise<string>;
	body: ReadableStream<Uint8Array> | null;
}

export type FetchLike = (url: string, init: {
	method: string;
	headers: Record<string, string>;
	body: string;
	signal?: AbortSignal;
}) => Promise<FetchLikeResponse>;

export interface ProxyConf {
	host: string;
	port: number;
	auth?: string;
}

export function parseProxy(proxy: string): ProxyConf {
	let raw = proxy.trim();
	if (/^socks/i.test(raw)) {
		throw new Error('SOCKS proxies are not supported — use an HTTP proxy, e.g. http://127.0.0.1:9000');
	}
	raw = raw.replace(/^https?:\/\//i, '');
	const m = /^(?:([^@/:]+):([^@/]*)@)?([a-zA-Z0-9.\-_]+):(\d+)$/.exec(raw);
	if (!m) {
		throw new Error(`invalid proxy address: ${proxy} (expected host:port, e.g. 127.0.0.1:9000)`);
	}
	const conf: ProxyConf = { host: m[3], port: Number(m[4]) };
	if (m[1] !== undefined) {
		conf.auth = 'Basic ' + btoa(`${m[1]}:${m[2] ?? ''}`);
	}
	return conf;
}

interface NodeReqLike {
	write(data: string): unknown;
	end(data?: string): unknown;
	on(ev: string, cb: (...args: unknown[]) => void): unknown;
	destroy(err?: Error): unknown;
}
interface NodeResLike {
	statusCode?: number;
	on(ev: string, cb: (...args: unknown[]) => void): unknown;
	destroy(): unknown;
	setEncoding(enc: string): unknown;
}
interface HttpModule {
	request(opts: Record<string, unknown>, cb?: (res: NodeResLike) => void): NodeReqLike;
}

function toError(e: unknown): Error {
	return e instanceof Error ? e : new Error(String(e));
}

function nodeRequire(mod: string): HttpModule {
	const w = typeof window !== 'undefined'
		? (window as unknown as { require?: (id: string) => HttpModule })
		: undefined;
	const req = w?.require;
	if (!req) {
		throw new Error('Node modules are unavailable here — the local proxy feature requires Obsidian desktop.');
	}
	return req(mod);
}

function proxyHeaders(conf: ProxyConf, extra: Record<string, string>): Record<string, string> {
	return { ...extra, ...(conf.auth ? { 'Proxy-Authorization': conf.auth } : {}) };
}

/** Plain-http target: forward through the proxy using the absolute URI form. */
function forwardRequest(conf: ProxyConf, url: string, init: {
	method: string;
	headers: Record<string, string>;
	body: string;
	signal?: AbortSignal;
}): Promise<NodeResLike> {
	return new Promise((resolve, reject) => {
		const http = nodeRequire('http');
		const u = new URL(url);
		const req = http.request({
			host: conf.host,
			port: conf.port,
			method: init.method,
			path: url,
			headers: proxyHeaders(conf, { ...init.headers, Host: u.host })
		}, (res) => resolve(res));
		req.on('error', (err: unknown) => reject(toError(err)));
		if (init.signal) {
			init.signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
		}
		if (init.body) req.write(init.body);
		req.end();
	});
}

/** https target: tunnel through the proxy with CONNECT, then run TLS over the socket. */
function connectAndRequest(conf: ProxyConf, url: string, init: {
	method: string;
	headers: Record<string, string>;
	body: string;
	signal?: AbortSignal;
}): Promise<NodeResLike> {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const port = Number(u.port) || 443;
		const http = nodeRequire('http');
		const https = nodeRequire('https');
		const conn = http.request({
			host: conf.host,
			port: conf.port,
			method: 'CONNECT',
			path: `${u.hostname}:${port}`,
			headers: proxyHeaders(conf, { Host: `${u.hostname}:${port}` })
		});
		conn.on('error', (err: unknown) => reject(toError(err)));
		if (init.signal) {
			init.signal.addEventListener('abort', () => conn.destroy(new Error('aborted')), { once: true });
		}
		conn.on('connect', (...args: unknown[]) => {
			const res = args[0] as NodeResLike;
			const socket = args[1] as Record<string, unknown>;
			if (res.statusCode !== 200) {
				res.destroy();
				reject(new Error(`proxy CONNECT failed with status ${res.statusCode}`));
				return;
			}
			const tlsReq = https.request({
				hostname: u.hostname,
				port,
				path: u.pathname + u.search,
				method: init.method,
				headers: init.headers,
				servername: u.hostname,
				createConnection: () => socket
			}, (res2) => resolve(res2));
			tlsReq.on('error', (err: unknown) => reject(toError(err)));
			if (init.signal) {
				init.signal.addEventListener('abort', () => tlsReq.destroy(new Error('aborted')), { once: true });
			}
			if (init.body) tlsReq.write(init.body);
			tlsReq.end();
		});
		conn.end();
	});
}

function toStream(nodeRes: NodeResLike): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			nodeRes.on('data', (...args: unknown[]) => {
				try {
					controller.enqueue(args[0] as Uint8Array);
				} catch {
					/* stream already closed */
				}
			});
			nodeRes.on('end', () => {
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			});
			nodeRes.on('error', (...args: unknown[]) => {
				try {
					controller.error(args[0] instanceof Error ? args[0] : new Error('stream error'));
				} catch {
					/* already closed */
				}
			});
		},
		cancel() {
			nodeRes.destroy();
		}
	});
}

export function makeProxyFetch(proxy: string): FetchLike {
	const conf = parseProxy(proxy);
	return async (url, init) => {
		const nodeRes = new URL(url).protocol === 'https:'
			? await connectAndRequest(conf, url, init)
			: await forwardRequest(conf, url, init);
		const status = nodeRes.statusCode ?? 0;
		let bodyUsed = false;
		let bodyStream: ReadableStream<Uint8Array> | null = null;
		const result: FetchLikeResponse = {
			ok: status >= 200 && status < 300,
			status,
			text: () => {
				if (bodyUsed) throw new Error('response body already consumed');
				bodyUsed = true;
				return new Promise((resolve, reject) => {
					let out = '';
					nodeRes.setEncoding('utf8');
					nodeRes.on('data', (...args: unknown[]) => {
						out += String(args[0]);
					});
					nodeRes.on('end', () => resolve(out));
					nodeRes.on('error', (...args: unknown[]) => reject(args[0] instanceof Error ? args[0] : new Error('stream error')));
				});
			},
			body: null
		};
		Object.defineProperty(result, 'body', {
			get: () => {
				if (bodyUsed) return null;
				bodyUsed = true;
				if (!bodyStream) bodyStream = toStream(nodeRes);
				return bodyStream;
			}
		});
		return result;
	};
}
