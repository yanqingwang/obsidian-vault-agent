import { App, ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, setIcon } from 'obsidian';
import { ChatMessage, ToolCall, runAgentLoop, ToolDef } from './agent';
import { t, Lang } from './i18n';
import { VaultToolExecutor, buildToolDefs } from './tools';
import type VaultAgentPlugin from './main';

export const VIEW_TYPE_AGENT = 'vault-agent-view';

export class AgentView extends ItemView {
	private messages: ChatMessage[] = [];
	private running = false;
	private abort: AbortController | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: VaultAgentPlugin) {
		super(leaf);
	}

	getViewType(): string { return VIEW_TYPE_AGENT; }
	getDisplayText(): string { return t(this.plugin.settings.lang, 'viewName'); }
	getIcon(): string { return t(this.plugin.settings.lang, 'viewIcon'); }

	async onOpen(): Promise<void> {
		this.messages = this.plugin.loadHistory();
		this.renderShell();
		if (!this.messages.length) this.addWelcome();
		else this.renderAllHistory();
	}

	async onClose(): Promise<void> {
		this.plugin.saveHistory(this.messages);
		this.abort?.abort();
	}

	private st(key: Parameters<typeof t>[1]): string { return t(this.plugin.settings.lang, key); }

	private renderShell(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass('va-root');

		const header = root.createDiv({ cls: 'va-header' });
		const brand = header.createDiv({ cls: 'va-brand' });
		setIcon(brand, 'bot-message-square');
		brand.createSpan({ text: this.st('viewName') + ' · ' + this.plugin.currentModelLabel() });
		const actions = header.createDiv({ cls: 'va-header-actions' });
		const newBtn = actions.createEl('button', { cls: 'va-icon-btn', attr: { 'aria-label': this.st('newChat') } });
		setIcon(newBtn, 'plus');
		newBtn.addEventListener('click', () => {
			if (this.running) return;
			this.messages = [];
			this.plugin.saveHistory([]);
			this.renderShell();
			this.addWelcome();
		});
		const clearBtn = actions.createEl('button', { cls: 'va-icon-btn', attr: { 'aria-label': this.st('clearChat') } });
		setIcon(clearBtn, 'trash-2');
		clearBtn.addEventListener('click', () => {
			if (this.running) return;
			this.messages = [];
			this.plugin.saveHistory([]);
			this.renderShell();
			this.addWelcome();
		});
		const settingsBtn = actions.createEl('button', { cls: 'va-icon-btn', attr: { 'aria-label': this.st('openSettings') } });
		setIcon(settingsBtn, 'settings');
		settingsBtn.addEventListener('click', () => this.plugin.openSettings());

		this.msgsEl = root.createDiv({ cls: 'va-messages' });
		this.inputAreaEl = root.createDiv({ cls: 'va-input-area' });
		const ta = this.inputAreaEl.createEl('textarea', { cls: 'va-input', attr: { placeholder: this.st('inputPlaceholder'), rows: '3' } });
		this.inputEl = ta;
		const sendBtn = this.inputAreaEl.createDiv({ cls: 'va-send-row' });
		this.stopBtn = sendBtn.createEl('button', { cls: 'va-stop-btn', text: '⏹ ' + this.st('stop') });
		this.stopBtn.hidden = true;
		this.stopBtn.addEventListener('click', () => this.abort?.abort());
		const send = sendBtn.createEl('button', { cls: 'va-send-btn mod-cta', text: '➤ ' + this.st('send') });
		send.addEventListener('click', () => void this.send());
		ta.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.send();
			}
		});
	}

	private msgsEl!: HTMLElement;
	private inputAreaEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private stopBtn!: HTMLButtonElement;

	private addWelcome(): void {
		const el = this.msgsEl.createDiv({ cls: 'va-welcome' });
		void MarkdownRenderer.render(this.app, this.st('welcome'), el, '', this);
	}

	private renderAllHistory(): void {
		for (const m of this.messages) {
			if (m.role === 'user') this.renderUserBubble(m.content ?? '');
			else if (m.role === 'assistant' && m.content) this.renderAssistantDone(m.content);
		}
		this.scrollBottom();
	}

	private scrollBottom(): void {
		this.msgsEl.scrollTop = this.msgsEl.scrollHeight;
	}

	private renderUserBubble(text: string): HTMLElement {
		const el = this.msgsEl.createDiv({ cls: 'va-msg va-user' });
		el.createDiv({ cls: 'va-user-text', text });
		this.scrollBottom();
		return el;
	}

	private renderAssistantDone(text: string): HTMLElement {
		const el = this.msgsEl.createDiv({ cls: 'va-msg va-assistant' });
		void MarkdownRenderer.render(this.app, text || '…', el, '', this);
		this.scrollBottom();
		return el;
	}

	/** Streaming assistant bubble: plain text while streaming, markdown once done. */
	private beginStreamingBubble(): { el: HTMLElement; textEl: HTMLElement; push(delta: string): void; finish(full: string): void } {
		const el = this.msgsEl.createDiv({ cls: 'va-msg va-assistant va-streaming' });
		const textEl = el.createDiv({ cls: 'va-stream-text' });
		let acc = '';
		return {
			el,
			textEl,
			push: (delta) => {
				acc += delta;
				textEl.textContent = acc;
				this.scrollBottom();
			},
			finish: (full) => {
				el.removeClass('va-streaming');
				textEl.remove();
				const done = el.createDiv({ cls: 'va-assistant-body' });
				void MarkdownRenderer.render(this.app, full || acc || '…', done, '', this);
				this.scrollBottom();
			}
		};
	}

	private addToolChip(call: ToolCall, result?: { ok: boolean; content: string }): HTMLElement {
		const chip = this.msgsEl.createDiv({ cls: 'va-tool-chip' + (result && !result.ok ? ' va-tool-error' : '') });
		const summary = chip.createDiv({ cls: 'va-tool-summary' });
		setIcon(summary, result ? (result.ok ? 'check' : 'x') : 'loader-2');
		let argsPreview = '';
		try {
			const a = JSON.parse(call.function.arguments || '{}');
			argsPreview = Object.entries(a).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(' ');
		} catch { argsPreview = call.function.arguments; }
		summary.createSpan({ text: `${call.function.name}  ${argsPreview.slice(0, 120)}` });
		const details = chip.createEl('details', { cls: 'va-tool-details' });
		details.createEl('summary', { text: this.st('toolResult') });
		details.createEl('pre', { text: result ? result.content.slice(0, 2000) : '…' });
		this.scrollBottom();
		return chip;
	}

	private buildSystemPrompt(): string {
		const s = this.plugin.settings;
		const active = this.app.workspace.getActiveFile();
		const zhMode = s.lang === 'zh';
		const base = s.systemPrompt.trim() || (
			zhMode
				? `你是 Obsidian 库（vault）内的智能体助手，可以借助工具读写和检索用户的笔记。规则：
- 涉及笔记内容时优先使用工具（search_notes/read_note/list_notes）获取真实内容，不要凭空编造笔记内容。
- 编辑笔记用 edit_note，old_string 必须与原文完全一致且唯一；新建用 create_note；追加用 append_note。
- 所有路径均为 vault 相对路径。新建笔记默认使用 Markdown，适当使用标题、列表和 [[wikilink]]。
- 用用户的语言回复；工具执行结果不要原样粘贴，提炼后再讲。`
				: `You are an agent inside an Obsidian vault. Use the provided tools to search, read, create and edit the user's notes.
- Always ground claims about notes in tool results; never invent note contents.
- Use edit_note with an exact, unique old_string; create_note for new files; append_note to add text.
- All paths are vault-relative. New notes are Markdown with sensible headings and [[wikilinks]].
- Reply in the user's language; summarize tool output instead of pasting it raw.`
		);
		const ctx: string[] = [];
		ctx.push(zhMode ? `库名：${this.app.vault.getName()}` : `Vault: ${this.app.vault.getName()}`);
		ctx.push(zhMode ? `今天日期：${new Date().toISOString().slice(0, 10)}` : `Today: ${new Date().toISOString().slice(0, 10)}`);
		if (s.autoContext) {
			ctx.push(zhMode
				? `当前打开的笔记：${active ? active.path : this.st('noActiveNote')}`
				: `Active note: ${active ? active.path : '(none)'}`);
		}
		return base + '\n\n' + ctx.join('\n');
	}

	private confirmWrite(summary: string): Promise<boolean> {
		const s = this.plugin.settings;
		if (s.autoApprove) return Promise.resolve(true);
		return new Promise(resolve => {
			const bar = this.msgsEl.createDiv({ cls: 'va-confirm' });
			bar.createSpan({ text: this.st('confirmTitle') + ' — ' + summary });
			const row = bar.createDiv({ cls: 'va-confirm-row' });
			const yes = row.createEl('button', { cls: 'mod-cta', text: this.st('confirmAllow') });
			const no = row.createEl('button', { text: this.st('confirmDeny') });
			const done = (v: boolean) => { bar.remove(); resolve(v); };
			yes.addEventListener('click', () => done(true));
			no.addEventListener('click', () => done(false));
			this.scrollBottom();
		});
	}

	async send(): Promise<void> {
		if (this.running) return;
		const s = this.plugin.settings;
		if (!s.apiKey.trim()) {
			new Notice(this.st('needApiKey'));
			this.plugin.openSettings();
			return;
		}
		const input = this.inputEl.value.trim();
		if (!input) return;
		this.inputEl.value = '';
		this.running = true;
		this.abort = new AbortController();
		this.stopBtn.hidden = false;

		this.renderUserBubble(input);
		this.messages.push({ role: 'user', content: input });
		if (this.messages[0]?.role !== 'system') {
			this.messages.unshift({ role: 'system', content: this.buildSystemPrompt() });
		} else {
			this.messages[0].content = this.buildSystemPrompt();
		}

		const stream = this.beginStreamingBubble();
		const tools: ToolDef[] = buildToolDefs();
		const executor = new VaultToolExecutor(this.app, () => this.app.workspace.getActiveFile()?.path ?? null);

		try {
			const { text, hitCap } = await runAgentLoop({
				baseUrl: s.baseUrl,
				apiKey: s.apiKey,
				model: s.model,
				temperature: s.temperature,
				maxTokens: s.maxTokens,
				maxIterations: s.maxIterations,
				messages: this.messages,
				tools,
				executor,
				signal: this.abort.signal,
				confirmWrite: (summary) => this.confirmWrite(summary),
				fallbackPost: this.plugin.fallbackPost.bind(this.plugin),
				onText: d => stream.push(d),
				onToolStart: call => this.addToolChip(call),
				onToolDone: (call, result) => this.addToolChip(call, result)
			});
			stream.finish(text);
			if (hitCap) new Notice(this.st('maxIterReached'));
			this.messages.push({ role: 'assistant', content: text });
		} catch (e) {
			const aborted = this.abort.signal.aborted;
			const msg = aborted ? (s.lang === 'zh' ? '（已停止）' : '(stopped)') : `${this.st('errPrefix')}: ${e instanceof Error ? e.message : String(e)}`;
			stream.finish(msg);
			this.messages.push({ role: 'assistant', content: msg });
			if (!aborted) new Notice(msg.slice(0, 200));
		} finally {
			this.running = false;
			this.stopBtn.hidden = true;
			this.plugin.saveHistory(this.messages);
		}
	}
}
