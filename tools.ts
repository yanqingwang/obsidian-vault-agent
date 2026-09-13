import { App, TFile, TFolder, normalizePath } from 'obsidian';
import { ToolDef, ToolExecutor, truncate } from './agent';

/**
 * Vault tools exposed to the model. Mirrors the shape of coding-agent tools
 * (read/edit/search/create) adapted to an Obsidian vault.
 */

const MAX_READ = 30000;
const MAX_RESULTS = 60;

export function buildToolDefs(): ToolDef[] {
	return [
		{
			name: 'list_notes',
			description: 'List note files in a folder of the vault (recursive).',
			parameters: {
				type: 'object',
				properties: {
					folder: { type: 'string', description: 'Folder path relative to vault root, "." for whole vault' },
					glob: { type: 'string', description: 'Optional filename substring filter, e.g. "meeting"' }
				},
				required: ['folder']
			}
		},
		{
			name: 'read_note',
			description: 'Read the full text of a note by path.',
			parameters: {
				type: 'object',
				properties: { path: { type: 'string', description: 'Vault-relative path, e.g. "Daily/2026-09-13.md"' } },
				required: ['path']
			}
		},
		{
			name: 'search_notes',
			description: 'Search note contents with a literal or regex pattern. Returns file, line number and context.',
			parameters: {
				type: 'object',
				properties: {
					pattern: { type: 'string', description: 'Text or regular expression' },
					regex: { type: 'boolean', description: 'Treat pattern as a regular expression (default false)' },
					folder: { type: 'string', description: 'Optional folder to limit the search' }
				},
				required: ['pattern']
			}
		},
		{
			name: 'get_active_note',
			description: 'Get the path and content of the note currently open in the editor.',
			parameters: { type: 'object', properties: {} }
		},
		{
			name: 'create_note',
			description: 'Create a new note (or overwrite an existing one when overwrite=true). Parent folders are created automatically.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Vault-relative path ending in .md' },
					content: { type: 'string', description: 'Full markdown content of the note' },
					overwrite: { type: 'boolean', description: 'Overwrite if the file exists (default false)' }
				},
				required: ['path', 'content']
			}
		},
		{
			name: 'edit_note',
			description: 'Replace an exact string inside an existing note. old_string must match exactly and uniquely; for non-unique matches include more surrounding lines.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Vault-relative path' },
					old_string: { type: 'string', description: 'Exact existing text to replace' },
					new_string: { type: 'string', description: 'Replacement text' },
					replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' }
				},
				required: ['path', 'old_string', 'new_string']
			}
		},
		{
			name: 'append_note',
			description: 'Append text to the end of an existing note (creates a leading blank line when needed).',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Vault-relative path' },
					content: { type: 'string', description: 'Text to append' }
				},
				required: ['path', 'content']
			}
		},
		{
			name: 'read_properties',
			description: 'Read frontmatter/properties and basic stats of a note.',
			parameters: {
				type: 'object',
				properties: { path: { type: 'string', description: 'Vault-relative path' } },
				required: ['path']
			}
		}
	];
}

export class VaultToolExecutor implements ToolExecutor {
	constructor(private app: App, private getActivePath: () => string | null) {}

	async execute(name: string, argsJson: string): Promise<{ ok: boolean; content: string }> {
		let parsed: unknown = {};
		try {
			parsed = JSON.parse(argsJson || '{}');
		} catch {
			return { ok: false, content: 'invalid JSON arguments' };
		}
		const args = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
		const s = (key: string, fallback = ''): string => {
			const v = args[key];
			return typeof v === 'string' ? v : v === undefined || v === null ? fallback : String(v);
		};
		const b = (key: string): boolean => args[key] === true;
		try {
			switch (name) {
				case 'list_notes': return ok(await this.listNotes(s('folder', '.'), args.glob === undefined ? undefined : s('glob')));
				case 'read_note': return ok(await this.readNote(s('path')));
				case 'search_notes': return ok(await this.searchNotes(s('pattern'), b('regex'), args.folder === undefined ? undefined : s('folder')));
				case 'get_active_note': return ok(await this.activeNote());
				case 'create_note': return ok(await this.createNote(s('path'), s('content'), b('overwrite')));
				case 'edit_note': return ok(await this.editNote(s('path'), s('old_string'), s('new_string'), b('replace_all')));
				case 'append_note': return ok(await this.appendNote(s('path'), s('content')));
				case 'read_properties': return ok(await this.readProperties(s('path')));
				default: return { ok: false, content: `unknown tool: ${name}` };
			}
		} catch (e: unknown) {
			return { ok: false, content: 'error: ' + (e instanceof Error ? e.message : String(e)) };
		}
	}

	private resolve(path: string): string {
		return normalizePath(String(path ?? '').trim().replace(/^\/+/, ''));
	}

	private async listNotes(folder: string, glob?: string): Promise<string> {
		const fp = this.resolve(folder);
		const af = this.app.vault.getAbstractFileByPath(fp);
		let files: TFile[];
		if (af instanceof TFolder) {
			files = this.app.vault.getMarkdownFiles().filter(f => f.path === fp || f.path.startsWith(fp === '/' ? '' : fp + '/'));
		} else if (af instanceof TFile) {
			files = [af];
		} else {
			files = this.app.vault.getMarkdownFiles();
		}
		if (glob) files = files.filter(f => f.name.toLowerCase().includes(String(glob).toLowerCase()));
		files = files.slice(0, 500);
		if (!files.length) return '(no notes found)';
		return files.map(f => `${f.path} (${f.stat.size}B)`).join('\n');
	}

	private async readNote(path: string): Promise<string> {
		const file = this.mustFile(path);
		const text = await this.app.vault.cachedRead(file);
		if (text.length > MAX_READ) {
			return truncate(text, MAX_READ) + `\n[note truncated; ${text.length} chars total — use search_notes or ask for a section]`;
		}
		return text || '(empty note)';
	}

	private async searchNotes(pattern: string, regex: boolean, folder?: string): Promise<string> {
		if (!pattern) return 'empty pattern';
		let re: RegExp;
		try {
			re = regex ? new RegExp(pattern, 'gi') : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
		} catch (e) {
			return 'invalid regex: ' + (e instanceof Error ? e.message : String(e));
		}
		const fp = folder ? this.resolve(folder) : null;
		const files = this.app.vault.getMarkdownFiles().filter(f => !fp || f.path === fp || f.path.startsWith(fp + '/'));
		const out: string[] = [];
		let hits = 0;
		for (const file of files) {
			if (hits >= MAX_RESULTS) break;
			const text = await this.app.vault.cachedRead(file);
			const lines = text.split('\n');
			for (let i = 0; i < lines.length && hits < MAX_RESULTS; i++) {
				re.lastIndex = 0;
				if (re.test(lines[i])) {
					out.push(`${file.path}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
					hits++;
				}
			}
		}
		return out.length ? out.join('\n') : '(no matches)';
	}

	private async activeNote(): Promise<string> {
		const path = this.getActivePath();
		if (!path) return '(no active note)';
		const file = this.app.vault.getFileByPath(path);
		if (!file) return `(active file not readable: ${path})`;
		const text = await this.app.vault.cachedRead(file);
		return `path: ${file.path}\n---\n` + truncate(text, MAX_READ);
	}

	private async ensureFolder(path: string): Promise<void> {
		const idx = path.lastIndexOf('/');
		if (idx <= 0) return;
		const dir = this.resolve(path.slice(0, idx));
		if (!dir || this.app.vault.getAbstractFileByPath(dir)) return;
		await this.ensureFolder(dir + '/x');
		if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
	}

	private async createNote(path: string, content: string, overwrite: boolean): Promise<string> {
		const p = this.resolve(path);
		if (!p) return 'missing path';
		if (!/\.(md|canvas)$/i.test(p)) return 'path must end with .md';
		const existing = this.app.vault.getFileByPath(p);
		if (existing) {
			if (!overwrite) return `file already exists: ${p}. Set overwrite=true to replace it, or use edit_note/append_note.`;
			await this.app.vault.modify(existing, content);
			return `overwrote ${p} (${content.length} chars)`;
		}
		await this.ensureFolder(p);
		await this.app.vault.create(p, content);
		return `created ${p} (${content.length} chars)`;
	}

	private async editNote(path: string, oldString: string, newString: string, replaceAll: boolean): Promise<string> {
		const file = this.mustFile(path);
		const text = await this.app.vault.read(file);
		const count = text.split(oldString).length - 1;
		if (count === 0) {
			return `old_string not found in ${file.path}. Read the note again and copy the exact text (including whitespace).`;
		}
		if (count > 1 && !replaceAll) {
			return `old_string appears ${count} times in ${file.path}. Provide more surrounding lines to make it unique, or set replace_all=true.`;
		}
		const updated = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString);
		await this.app.vault.modify(file, updated);
		return `edited ${file.path} (${count} occurrence${count > 1 ? 's' : ''} replaced)`;
	}

	private async appendNote(path: string, content: string): Promise<string> {
		const file = this.mustFile(path);
		const text = await this.app.vault.read(file);
		const glue = text.length && !text.endsWith('\n') ? '\n' : '';
		await this.app.vault.modify(file, text + glue + '\n' + content);
		return `appended ${content.length} chars to ${file.path}`;
	}

	private async readProperties(path: string): Promise<string> {
		const file = this.mustFile(path);
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter ?? {};
		const lines = [
			`path: ${file.path}`,
			`size: ${file.stat.size}B`,
			`tags: ${(cache?.tags ?? []).map(t => t.tag).join(', ') || '(none)'}`,
			`frontmatter: ${JSON.stringify(fm)}`
		];
		return lines.join('\n');
	}

	private mustFile(path: string): TFile {
		const p = this.resolve(path);
		const file = this.app.vault.getFileByPath(p);
		if (!file) throw new Error(`note not found: ${p}`);
		if (!(file instanceof TFile)) throw new Error(`not a file: ${p}`);
		return file;
	}
}

function ok(content: string) {
	return { ok: true, content };
}
