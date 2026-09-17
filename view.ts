import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, setIcon } from 'obsidian';
import { ChatMessage, ToolCall, runAgentLoop, ToolDef, normalizeReasoning } from './agent';
import { t } from './i18n';
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
		// An empty transcript means a new conversation: give it its own session id.
		if (!this.messages.length) this.plugin.startSession();
		this.renderShell();
		if (!this.messages.length) this.addWelcome();
		else this.renderAllHistory();
	}

	async onClose(): Promise<void> {
		await this.plugin.saveHistory(this.messages);
		await this.plugin.history.flush();
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
			this.plugin.startSession();
			this.messages = [];
			void this.plugin.saveHistory([]);
			this.renderShell();
			this.addWelcome();
		});
		const clearBtn = actions.createEl('button', { cls: 'va-icon-btn', attr: { 'aria-label': this.st('clearChat') } });
		setIcon(clearBtn, 'trash-2');
		clearBtn.addEventListener('click', () => {
			if (this.running) return;
			this.plugin.startSession();
			this.messages = [];
			void this.plugin.saveHistory([]);
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
		const btnRow = this.inputAreaEl.createDiv({ cls: 'va-send-row' });
		this.stopBtn = btnRow.createEl('button', { cls: 'va-stop-btn', text: '⏹ ' + this.st('stop') });
		this.stopBtn.disabled = true;
		this.stopBtn.addEventListener('click', () => this.abort?.abort());
		this.sendBtn = btnRow.createEl('button', { cls: 'va-send-btn mod-cta', text: '➤ ' + this.st('send') });
		this.sendBtn.addEventListener('click', () => void this.send());
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
	private sendBtn!: HTMLButtonElement;

	private addWelcome(): void {
		const el = this.msgsEl.createDiv({ cls: 'va-welcome' });
		this.renderMarkdown(el, this.st('welcome'));
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

	/**
	 * Render markdown without the stray blank lines Obsidian's renderer produces
	 * (empty <p> from leading/trailing newlines, <br> runs at block edges).
	 */
	private renderMarkdown(container: HTMLElement, text: string): void {
		void MarkdownRenderer.render(this.app, text.trim() || '…', container, '', this).then(() => {
			container.querySelectorAll('br').forEach(br => {
				const parent = br.parentElement;
				if (!parent) return;
				if (br.previousElementSibling === null || br.nextElementSibling === null || br.previousElementSibling?.tagName === 'BR') {
					br.remove();
				}
			});
			container.querySelectorAll('p, li').forEach(p => {
				if (!p.textContent?.trim() && !p.querySelector('img,video,a,code,pre,table,svg')) p.remove();
			});
		});
	}

	private renderUserBubble(text: string): HTMLElement {
		const el = this.msgsEl.createDiv({ cls: 'va-msg va-user' });
		el.createDiv({ cls: 'va-user-text', text });
		this.scrollBottom();
		return el;
	}

	private renderAssistantDone(text: string): HTMLElement {
		const el = this.msgsEl.createDiv({ cls: 'va-msg va-assistant' });
		this.renderMarkdown(el, text);
		this.scrollBottom();
		return el;
	}

	/**
	 * Streaming assistant bubble: reasoning (if the model streams it) goes into a
	 * collapsible block that stays collapsed above the answer once done.
	 */
	private beginStreamingBubble(): {
		el: HTMLElement;
		push(delta: string): void;
		pushReasoning(delta: string): void;
		finish(full: string, reasoning: string): void;
	} {
		const el = this.msgsEl.createDiv({ cls: 'va-msg va-assistant va-streaming' });
		const textEl = el.createDiv({ cls: 'va-stream-text' });
		let acc = '';
		let reasoningEl: HTMLElement | null = null;
		let reasoningTextEl: HTMLElement | null = null;
		let reasoningAcc = '';
		return {
			el,
			push: (delta) => {
				acc += delta;
				textEl.textContent = acc;
				this.scrollBottom();
			},
			pushReasoning: (delta) => {
				let d = reasoningEl;
				if (!d) {
					d = el.createEl('details', { cls: 'va-reasoning' });
					d.setAttribute('open', '');
					d.createEl('summary', { text: this.st('thinking') });
					reasoningTextEl = d.createDiv({ cls: 'va-reasoning-text' });
					el.insertBefore(d, textEl);
					reasoningEl = d;
				}
				reasoningAcc += delta;
				if (reasoningTextEl) {
					reasoningTextEl.textContent = normalizeReasoning(reasoningAcc);
					reasoningTextEl.scrollTop = reasoningTextEl.scrollHeight;
				}
				this.scrollBottom();
			},
			finish: (full, reasoning) => {
				el.removeClass('va-streaming');
				textEl.remove();
				const finalReasoning = normalizeReasoning(reasoning || reasoningAcc);
				if (finalReasoning) {
					if (!reasoningEl) {
						reasoningEl = el.createEl('details', { cls: 'va-reasoning' });
						reasoningEl.createEl('summary', { text: this.st('thought') });
						reasoningTextEl = reasoningEl.createDiv({ cls: 'va-reasoning-text' });
					}
					reasoningEl.removeAttribute('open');
					const summary = reasoningEl.querySelector('summary');
					if (summary) summary.textContent = this.st('thought');
					if (reasoningTextEl) reasoningTextEl.textContent = finalReasoning;
				} else if (reasoningEl) {
					reasoningEl.remove();
				}
				const done = el.createDiv({ cls: 'va-assistant-body' });
				this.renderMarkdown(done, full || acc);
				this.scrollBottom();
			}
		};
	}

	private addToolChip(call: ToolCall): HTMLElement {
		const chip = this.msgsEl.createDiv({ cls: 'va-tool-chip' });
		const summary = chip.createDiv({ cls: 'va-tool-summary' });
		const icon = summary.createSpan({ cls: 'va-tool-icon' });
		setIcon(icon, 'loader-2');
		icon.addClass('va-spinner');
		let argsPreview = '';
		try {
			const a: unknown = JSON.parse(call.function.arguments || '{}');
			if (a !== null && typeof a === 'object') {
				argsPreview = Object.entries(a).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(' ');
			}
		} catch { argsPreview = call.function.arguments; }
		summary.createSpan({ text: `${call.function.name}  ${argsPreview.slice(0, 120)}` });
		const details = chip.createEl('details', { cls: 'va-tool-details' });
		details.createEl('summary', { text: this.st('toolResult') });
		details.createEl('pre', { text: '…' });
		this.scrollBottom();
		return chip;
	}

	/** Fill in the result of a tool call on its existing chip (single chip per call). */
	private completeToolChip(chip: HTMLElement, result: { ok: boolean; content: string }): void {
		if (!result.ok) chip.addClass('va-tool-error');
		const icon = chip.querySelector<HTMLElement>('.va-tool-icon');
		if (icon) {
			setIcon(icon, result.ok ? 'check' : 'x');
			icon.removeClass('va-spinner');
		}
		const pre = chip.querySelector('.va-tool-details pre');
		if (pre) pre.textContent = result.content.slice(0, 2000);
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
		this.stopBtn.disabled = false;
		this.sendBtn.disabled = true;

		this.renderUserBubble(input);
		this.messages.push({ role: 'user', content: input });
		const history = this.plugin.history;
		history.user(input);
		if (this.messages[0]?.role !== 'system') {
			this.messages.unshift({ role: 'system', content: this.buildSystemPrompt() });
		} else {
			this.messages[0].content = this.buildSystemPrompt();
		}

		const stream = this.beginStreamingBubble();
		const tools: ToolDef[] = buildToolDefs();
		const executor = new VaultToolExecutor(this.app, () => this.app.workspace.getActiveFile()?.path ?? null);
		// Tool calls execute sequentially: chips complete in FIFO order.
		const chipQueue: HTMLElement[] = [];
		const toolStartedAt = new Map<string, number>();

		try {
			const fetchImpl: typeof fetch = (url, init) => window.fetch(url, init);
			const { text, reasoning, hitCap } = await runAgentLoop({
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
				fetchImpl,
				fallbackPost: (url, headers, body) => this.plugin.fallbackPost(url, headers, body),
				onText: d => stream.push(d),
				onReasoning: d => stream.pushReasoning(d),
				onToolStart: call => {
					toolStartedAt.set(call.id, Date.now());
					history.toolCall(call);
					chipQueue.push(this.addToolChip(call));
				},
				onToolDone: (call, result) => {
					history.toolResult(call, result, Date.now() - (toolStartedAt.get(call.id) ?? Date.now()));
					const chip = chipQueue.shift();
					if (chip) this.completeToolChip(chip, result);
				}
			});
			stream.finish(text, reasoning);
			if (hitCap) new Notice(this.st('maxIterReached'));
			this.messages.push({ role: 'assistant', content: text });
			history.assistant(text, reasoning);
		} catch (e: unknown) {
			const aborted = this.abort.signal.aborted;
			const msg = aborted ? (s.lang === 'zh' ? '（已停止）' : '(stopped)') : `${this.st('errPrefix')}: ${e instanceof Error ? e.message : String(e)}`;
			stream.finish(msg, '');
			this.messages.push({ role: 'assistant', content: msg });
			history.error(msg);
			if (!aborted) new Notice(msg.slice(0, 200));
		} finally {
			this.running = false;
			this.stopBtn.disabled = true;
			this.sendBtn.disabled = false;
			void this.plugin.saveHistory(this.messages);
		}
	}
}
