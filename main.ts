import { App, Plugin, PluginSettingTab, Setting, requestUrl, WorkspaceLeaf, type SettingDefinitionItem } from 'obsidian';
import { AgentView, VIEW_TYPE_AGENT } from './view';
import { t, Lang } from './i18n';

export interface ProviderPreset {
	id: string;
	label: string;
	baseUrl: string;
	models: string[];
	hint?: string;
}

/** Curated OpenAI-compatible providers. "同源" rows are the model vendors behind popular Chinese AI tools. */
export const PROVIDERS: ProviderPreset[] = [
	{ id: 'deepseek', label: 'DeepSeek 深度求索', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
	{ id: 'glm', label: '智谱 GLM (bigmodel.cn)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.6', 'glm-4.5-air'], hint: '模型 ID 以 bigmodel.cn 控制台为准' },
	{ id: 'zai', label: 'Z.ai (GLM 海外版)', baseUrl: 'https://api.z.ai/api/paas/v4', models: ['glm-4.6', 'glm-4.5-air'] },
	{ id: 'kimi', label: 'Kimi (Moonshot 月之暗面)', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k2-turbo-preview', 'kimi-k2-preview', 'moonshot-v1-32k'], hint: 'K 系列模型 ID 以 platform.moonshot.cn 为准' },
	{ id: 'qwen', label: '通义 Qwen (DashScope · Qoder 同源)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen3-coder-plus', 'qwen-plus', 'qwen-max'] },
	{ id: 'ark', label: '火山方舟 Ark (豆包 · Trae 同源)', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-seed-1-6-250615'], hint: '方舟需填推理接入点 ID（ep-xxx）或模型 ID，以火山控制台为准' },
	{ id: 'hunyuan', label: '腾讯混元 Hunyuan (WorkBuddy 同源)', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', models: ['hunyuan-turbos-latest', 'hunyuan-t1-latest'] },
	{ id: 'hermes', label: 'Hermes (Nous Research)', baseUrl: 'https://inference-api.nousresearch.com/v1', models: ['Hermes-4-405B', 'Hermes-4-70B'], hint: '也可用 OpenRouter 转发（选 OpenRouter 并填 nousresearch/hermes-4-405b）' },
	{ id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['nousresearch/hermes-4-405b', 'deepseek/deepseek-chat-v3.1'] },
	{ id: 'custom', label: '自定义 OpenAI 兼容端点', baseUrl: '', models: [], hint: '填写任意 OpenAI 兼容 Base URL 与模型 ID' }
];

export interface VASettings {
	providerId: string;
	baseUrl: string;
	apiKey: string;
	model: string;
	temperature: number;
	maxTokens: number;
	maxIterations: number;
	autoContext: boolean;
	autoApprove: boolean;
	systemPrompt: string;
	lang: Lang;
	history: ChatMessage[];
}

const DEFAULT_SETTINGS: VASettings = {
	providerId: 'deepseek',
	baseUrl: 'https://api.deepseek.com/v1',
	apiKey: '',
	model: 'deepseek-chat',
	temperature: 0.7,
	maxTokens: 8192,
	maxIterations: 12,
	autoContext: true,
	autoApprove: false,
	systemPrompt: '',
	lang: 'zh',
	history: []
};

type ChatMessage = import('./agent').ChatMessage;

export default class VaultAgentPlugin extends Plugin {
	settings: VASettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.registerView(VIEW_TYPE_AGENT, (leaf: WorkspaceLeaf) => new AgentView(leaf, this));
		this.addRibbonIcon('bot-message-square', t(this.settings.lang, 'viewName'), () => void this.revealAgent());
		this.addCommand({ id: 'open-agent', name: '打开智能体 / open agent', callback: () => void this.revealAgent() });
		this.addSettingTab(new VASettingTab(this.app, this));
	}

	onunload(): void {
		// Obsidian detaches registered views automatically.
	}

	/** Open (or reveal) the agent view; safe to call repeatedly. */
	async revealAgent(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_AGENT);
		if (existing.length) {
			await this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
		await leaf.setViewState({ type: VIEW_TYPE_AGENT, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	openSettings(): void {
		const setting = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
		setting.open();
		setting.openTabById(this.manifest.id);
	}

	currentModelLabel(): string {
		return this.settings.model || this.settings.baseUrl || 'not configured';
	}

	/** Non-streaming fallback used when direct fetch streaming fails (e.g. CORS). */
	async fallbackPost(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
		const res = await requestUrl({ url, method: 'POST', headers, body, throw: false });
		return { status: res.status, body: res.text };
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<VASettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	loadHistory(): ChatMessage[] {
		const h = this.settings.history;
		return Array.isArray(h) ? h.slice(-40) : [];
	}

	async saveHistory(messages: ChatMessage[]): Promise<void> {
		this.settings.history = messages.filter(m => m.role !== 'system').slice(-40);
		await this.saveData(this.settings);
	}
}

class VASettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: VaultAgentPlugin) {
		super(app, plugin);
	}

	private st(key: Parameters<typeof t>[1]): string { return t(this.plugin.settings.lang, key); }

	/**
	 * Declarative settings (Obsidian 1.13+): makes settings searchable.
	 * display() below still renders for older Obsidian versions.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;
		const providerHint = PROVIDERS.find(p => p.id === s.providerId)?.hint;
		return [
			{
				name: this.st('language'),
				desc: this.st('languageDesc'),
				control: { type: 'dropdown', key: 'lang', options: { zh: '中文', en: 'English' } }
			},
			{
				name: this.st('provider'),
				desc: this.st('providerDesc') + (providerHint ? '\nℹ️ ' + providerHint : ''),
				control: { type: 'dropdown', key: 'providerId', options: Object.fromEntries(PROVIDERS.map(p => [p.id, p.label])) }
			},
			{
				name: this.st('baseUrl'),
				control: { type: 'text', key: 'baseUrl', placeholder: 'https://api.example.com/v1' }
			},
			{
				name: this.st('apiKey'),
				desc: this.st('apiKeyDesc'),
				control: { type: 'text', key: 'apiKey', placeholder: 'sk-…' }
			},
			{
				name: this.st('model'),
				desc: this.st('modelDesc'),
				control: { type: 'text', key: 'model' }
			},
			{
				name: this.st('modelPreset'),
				searchable: false,
				visible: () => !!(PROVIDERS.find(p => p.id === this.plugin.settings.providerId)?.models.length),
				render: (setting) => {
					const preset = PROVIDERS.find(p => p.id === this.plugin.settings.providerId);
					for (const m of preset?.models ?? []) {
						const btn = setting.controlEl.createEl('button', { text: m });
						if (m === this.plugin.settings.model) btn.addClass('va-chip-active');
						btn.addEventListener('click', () => {
							this.plugin.settings.model = m;
							void this.plugin.saveSettings();
							setting.controlEl.querySelectorAll('button').forEach(b => b.removeClass('va-chip-active'));
							btn.addClass('va-chip-active');
						});
					}
					return () => setting.controlEl.empty();
				}
			},
			{
				name: this.st('temperature'),
				control: { type: 'slider', key: 'temperature', min: 0, max: 2, step: 0.1 }
			},
			{
				name: this.st('maxTokens'),
				control: {
					type: 'number',
					key: 'maxTokens',
					step: 1,
					validate: (v) => (typeof v === 'number' && v > 0 ? undefined : 'must be a positive number')
				}
			},
			{
				name: this.st('maxIterations'),
				control: {
					type: 'number',
					key: 'maxIterations',
					step: 1,
					validate: (v) => (typeof v === 'number' && v > 0 ? undefined : 'must be a positive number')
				}
			},
			{
				name: this.st('autoContext'),
				desc: this.st('autoContextDesc'),
				control: { type: 'toggle', key: 'autoContext' }
			},
			{
				name: this.st('autoApprove'),
				desc: this.st('autoApproveDesc'),
				control: { type: 'toggle', key: 'autoApprove' }
			},
			{
				name: this.st('systemPrompt'),
				desc: this.st('systemPromptDesc'),
				control: { type: 'textarea', key: 'systemPrompt', rows: 4 }
			}
		];
	}

	override getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		(s as unknown as Record<string, unknown>)[key] = value;
		if (key === 'providerId' && typeof value === 'string') {
			// Switching provider refreshes the base URL and default model.
			const preset = PROVIDERS.find(p => p.id === value);
			if (preset) {
				s.baseUrl = preset.baseUrl;
				if (preset.models.length) s.model = preset.models[0];
			}
		}
		await this.plugin.saveSettings();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		new Setting(containerEl).setName(this.st('settingsHeading')).setHeading();

		new Setting(containerEl)
			.setName(this.st('language'))
			.setDesc(this.st('languageDesc'))
			.addDropdown(d => d
				.addOption('zh', '中文')
				.addOption('en', 'English')
				.setValue(s.lang)
				.onChange(async v => { s.lang = v as Lang; await this.plugin.saveSettings(); }));

		const providerNames = PROVIDERS.map(p => [p.id, p.label] as [string, string]);
		new Setting(containerEl)
			.setName(this.st('provider'))
			.setDesc(this.st('providerDesc'))
			.addDropdown(d => {
				for (const [id, label] of providerNames) d.addOption(id, label);
				d.setValue(s.providerId).onChange(async v => {
					const preset = PROVIDERS.find(p => p.id === v);
					if (preset) {
						s.baseUrl = preset.baseUrl;
						if (preset.models.length) s.model = preset.models[0];
					}
					s.providerId = v;
					await this.plugin.saveSettings();
					this.renderProviderExtras(containerEl);
				});
			});

		new Setting(containerEl).setName(this.st('baseUrl')).addText(tx => tx
			.setValue(s.baseUrl)
			.onChange(async v => { s.baseUrl = v.trim(); await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName(this.st('apiKey'))
			.setDesc(this.st('apiKeyDesc'))
			.addText(tx => {
				tx.inputEl.type = 'password';
				tx.setValue(s.apiKey)
					.onChange(async v => { s.apiKey = v.trim(); await this.plugin.saveSettings(); });
			});

		const modelSetting = new Setting(containerEl)
			.setName(this.st('model'))
			.setDesc(this.st('modelDesc'));
		modelSetting.addText(tx => tx
			.setValue(s.model)
			.onChange(async v => { s.model = v.trim(); await this.plugin.saveSettings(); }));

		this.renderProviderExtras(containerEl);

		new Setting(containerEl).setName(this.st('temperature'))
			.addSlider(sl => sl.setLimits(0, 2, 0.1).setValue(s.temperature)
				.onChange(async v => { s.temperature = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl).setName(this.st('maxTokens'))
			.addText(tx => tx.setValue(String(s.maxTokens)).onChange(async v => {
				const n = parseInt(v, 10);
				if (n > 0) { s.maxTokens = n; await this.plugin.saveSettings(); }
			}));

		new Setting(containerEl).setName(this.st('maxIterations'))
			.addText(tx => tx.setValue(String(s.maxIterations)).onChange(async v => {
				const n = parseInt(v, 10);
				if (n > 0) { s.maxIterations = n; await this.plugin.saveSettings(); }
			}));

		new Setting(containerEl)
			.setName(this.st('autoContext'))
			.setDesc(this.st('autoContextDesc'))
			.addToggle(tg => tg.setValue(s.autoContext).onChange(async v => { s.autoContext = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName(this.st('autoApprove'))
			.setDesc(this.st('autoApproveDesc'))
			.addToggle(tg => tg.setValue(s.autoApprove).onChange(async v => { s.autoApprove = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName(this.st('systemPrompt'))
			.setDesc(this.st('systemPromptDesc'))
			.addTextArea(ta => ta.setValue(s.systemPrompt).onChange(async v => { s.systemPrompt = v; await this.plugin.saveSettings(); }));
	}

	/** Provider hint + model preset chips; re-rendered in place when the provider changes. */
	private renderProviderExtras(containerEl: HTMLElement): void {
		const s = this.plugin.settings;
		const preset = PROVIDERS.find(p => p.id === s.providerId);

		if (preset?.hint) {
			const hint = new Setting(containerEl).setClass('va-hint');
			hint.nameEl.setText('ℹ️ ' + preset.hint);
		}

		if (!preset?.models.length) return;
		const presets = new Setting(containerEl).setName(this.st('modelPreset')).setClass('va-model-chips');
		for (const m of preset.models) {
			presets.addButton(b => {
				b.setButtonText(m);
				if (s.model === m) b.buttonEl.addClass('va-chip-active');
				b.onClick(async () => {
					s.model = m;
					await this.plugin.saveSettings();
					presets.controlEl.querySelectorAll('button').forEach(el => el.removeClass('va-chip-active'));
					b.buttonEl.addClass('va-chip-active');
				});
			});
		}
	}
}
