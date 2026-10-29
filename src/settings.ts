import { App, Notice, PluginSettingTab, Setting, SettingDefinitionItem, moment } from 'obsidian';
import { AiError, DEFAULT_PROVIDER, ProviderId, TEST_COST_NOTE, describeFailure, listModels, presetFor, presets, testConnection } from './ai/providers';
import { tr } from './i18n';
import JapanWorkSecretaryPlugin from './main';
import { StoreConfig, cloneDefaultStoreConfigs, normalizeStoreConfigs } from './data';

import { DEFAULT_INCOME_ALERTS, IncomeAlert } from './incomeAlerts';
export { DEFAULT_INCOME_ALERTS, migrateIncomeAlerts } from './incomeAlerts';
export type { IncomeAlert } from './incomeAlerts';

export interface JapanWorkSecretarySettings {
	/** AI service for reading schedules. Gemini uses its own API; the others speak the OpenAI chat format. */
	aiProvider: ProviderId;
	/** Empty means the service's own address. */
	aiBaseUrl: string;
	aiModel: string;
	/** Name of the secret in Obsidian's secret storage that holds the key. */
	aiSecretName: string;
	// Gemini key before 1.4.0; migrated into secret storage on load.
	geminiApiKey: string;
	useMacKeychainForGeminiApiKey: boolean;
	calendarName: string;
	storeConfigs: StoreConfig[];
	baseWage: number;
	morningWage: number; // 05:00～09:00
	eveningWage: number; // 17:00～22:00
	nightWage: number; // 22:00～05:00 (深夜)
	holidayBonus: number; // store allowance on Sundays and public holidays (日祝手当), per hour
	/** Weekday the employer set as the statutory rest day (法定休日), 0 = Sunday; -1 when none is set. */
	statutoryRestDay: number;
	/** Pay rate for work on that day; the legal minimum is 1.35. */
	restDayWorkRate: number;
	commutingAllowance: number; // 交通费 (每日)
	incomeAlerts: IncomeAlert[];
	vacationPeriods: string[]; // "YYYY-MM-DD~YYYY-MM-DD"
	eventTitlePrefix: string;
	exportFolder: string;
	// Legacy toggles from 1.1.x, migrated into incomeAlerts on load.
	taxWall88k?: boolean;
	taxWall103k?: boolean;
	taxWall130k?: boolean;
	overtimeRate: number; // e.g. 1.25
	paidLeaveBalance: number; // Days
	payrollStartDay: number; // e.g., 21
	customHolidays: string[]; // YYYY-MM-DD
	holidayCache: { [date: string]: string };
	holidayCacheUpdatedAt: number;
}

export const DEFAULT_SETTINGS: JapanWorkSecretarySettings = {
	aiProvider: DEFAULT_PROVIDER,
	aiBaseUrl: '',
	aiModel: '',
	aiSecretName: '',
	geminiApiKey: '',
	useMacKeychainForGeminiApiKey: false,
	calendarName: 'Work',
	storeConfigs: cloneDefaultStoreConfigs(),
	baseWage: 1370,
	morningWage: 1510,
	eveningWage: 1440,
	nightWage: 1720,
	holidayBonus: 50,
	statutoryRestDay: -1,
	restDayWorkRate: 1.35,
	commutingAllowance: 0,
	incomeAlerts: DEFAULT_INCOME_ALERTS.map(alert => ({ ...alert })),
	vacationPeriods: [],
	eventTitlePrefix: '打工',
	exportFolder: 'Japan Work Secretary',
	overtimeRate: 1.25,
	paidLeaveBalance: 10,
	payrollStartDay: 21,
	customHolidays: [],
	holidayCache: {},
	holidayCacheUpdatedAt: 0,
}

/** Reads a value by a dotted path such as "storeConfigs.0.wageBands.1.baseWage". */
function readPath(root: unknown, path: string): unknown {
	return path.split('.').reduce<unknown>((value, part) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined), root);
}

function writePath(root: object, path: string, value: unknown) {
	const parts = path.split('.');
	const last = parts.pop();
	const target = parts.reduce<unknown>((obj, part) => (obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[part] : undefined), root);
	if (last && target && typeof target === 'object') (target as Record<string, unknown>)[last] = value;
}

const asText = (value: unknown) => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
const lines = (value: unknown) => asText(value).split('\n').map(line => line.trim()).filter(Boolean);
/** Keys whose stored value is a list but whose control is one text box. */
const LIST_KEYS = new Set(['customHolidays', 'vacationPeriods']);

const bandLabels = () => [
	{ key: 'baseWage', label: tr('Base wage (09:00–17:00)', '基本时薪（09:00–17:00）') },
	{ key: 'morningWage', label: tr('Morning wage (05:00–09:00)', '早班时薪（05:00–09:00）') },
	{ key: 'eveningWage', label: tr('Evening wage (17:00–22:00)', '晚班时薪（17:00–22:00）') },
	{ key: 'nightWage', label: tr('Late-night wage (22:00–05:00)', '深夜时薪（22:00–05:00）') },
	{ key: 'holidayBonus', label: tr('Store bonus on Sundays and public holidays, per hour', '店铺周日和节假日津贴（每小时）') },
	{ key: 'commutingAllowance', label: tr('Daily commuting allowance', '每日交通费') }
];

export class JapanWorkSecretarySettingTab extends PluginSettingTab {
	plugin: JapanWorkSecretaryPlugin;

	constructor(app: App, plugin: JapanWorkSecretaryPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.containerEl.addClass('jws-settings', 'ap', 'ap-settings');
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;
		settings.storeConfigs = normalizeStoreConfigs(settings.storeConfigs);
		const money = (key: string, name: string, desc?: string) => ({ name, desc, control: { type: 'number' as const, key, min: 0, step: 1 } });
		const holidayUpdatedText = settings.holidayCacheUpdatedAt ? new Date(settings.holidayCacheUpdatedAt).toLocaleString() : tr('never', '从未');
		const weekdays: Record<string, string> = { '-1': tr('Not set', '未设') };
		moment.weekdays().forEach((name, day) => { weekdays[String(day)] = name; });

		return [
			{
				type: 'group',
				heading: tr('AI for reading schedules', 'AI 读班表'),
				items: [
					{ name: tr('Service', '服务商'), desc: tr('Optional. Only used when you read shifts from selected text or from images in a note; the text or image is sent to this service then, and nothing else. Wages, limits and the calendar work without it.', '可不设。只在“从选中文字／笔记图片读取班次”时使用，那时才把这段文字或图片发给这个服务，别的不发。工资、工时上限和日历都不需要它。'), control: { type: 'dropdown', key: 'aiProvider', options: Object.fromEntries(presets().map(p => [p.id, p.name])) } },
					{ name: tr('Address', '接口地址'), desc: tr('Change it only for a proxy, another region or a local server.', '只有用代理、其他地区或本地服务时才需要改。'), control: { type: 'text', key: 'aiBaseUrl', placeholder: presetFor(settings.aiProvider).baseUrl } },
					{ name: tr('Model', '模型'), desc: tr('Must read images if you read schedule photos. Type a name or fetch the list below.', '读排班照片时要选能识图的模型。直接填，或在下面取模型列表。'), control: { type: 'text', key: 'aiModel', placeholder: presetFor(settings.aiProvider).model } },
					{ name: tr('Model list', '模型列表'), desc: tr('Asks the service which models this key can use. Free.', '向服务商查询这个密钥能用的模型，不收费。'), render: (setting: Setting) => this.renderModelList(setting) },
					{ name: tr('API key', 'API 密钥'), desc: this.keyDesc(), control: { type: 'secret', key: 'aiSecretName' } },
					{ name: tr('Test connection', '测试连接'), desc: TEST_COST_NOTE(), render: (setting: Setting) => this.renderTest(setting) }
				]
			},
			{ name: tr('macOS Calendar name', 'macOS 日历名称'), desc: tr('Target calendar in macOS Calendar. Changing it syncs into the new calendar; existing events in the previous calendar are not removed automatically.', '写入 macOS 日历里的哪个日历。改了以后同步到新日历，旧日历里已有的事件不会自动删除。'), control: { type: 'text', key: 'calendarName', placeholder: DEFAULT_SETTINGS.calendarName } },
			{ name: tr('Event title prefix', '事件标题前缀'), desc: tr('Calendar events are titled "<prefix>: <store>". Existing events are matched by a hidden marker, so changing this only renames them on the next sync.', '日历事件标题为“前缀: 店名”。已有事件靠隐藏标记识别，改前缀只会在下次同步时改名。'), control: { type: 'text', key: 'eventTitlePrefix', placeholder: DEFAULT_SETTINGS.eventTitlePrefix } },
			{ name: tr('Export folder', '导出文件夹'), desc: tr('Where pay notes and .ics calendar files are saved.', '工资笔记和 .ics 日历文件的保存位置。'), control: { type: 'folder', key: 'exportFolder', placeholder: DEFAULT_SETTINGS.exportFolder } },
			{
				type: 'group',
				heading: tr('Default wage bands', '默认时薪段'),
				items: [
					{ name: tr('Across the day', '一天里的时薪'), render: (setting: Setting) => this.drawBandStrip(setting) },
					...bandLabels().map(({ key, label }) => money(key, label))
				]
			},
			{
				type: 'list',
				heading: tr('Wage bands by store', '各店时薪段'),
				emptyState: tr('Each store can override the default wage bands above.', '每家店可以单独设时薪，覆盖上面的默认值。'),
				addItem: { name: tr('Add store', '加一家店'), action: () => {
					const name = tr(`Store ${settings.storeConfigs.length + 1}`, `店铺 ${settings.storeConfigs.length + 1}`);
					const base = settings.storeConfigs[0] ?? cloneDefaultStoreConfigs()[0];
					settings.storeConfigs.push({ ...base, id: `store-${Date.now().toString(36)}`, name, shortName: name, aliases: [name], colorClass: '' });
					void this.saveAndUpdate();
				} },
				onDelete: index => {
					if (settings.storeConfigs.length <= 1) return;
					settings.storeConfigs.splice(index, 1);
					void this.saveAndUpdate();
				},
				items: settings.storeConfigs.map((store, i) => ({
					type: 'page' as const,
					name: store.name,
					desc: tr(`${(store.wageBands || []).length} wage band(s)`, `${(store.wageBands || []).length} 个时薪段`),
					items: [
						{ name: tr('Store name', '店名'), control: { type: 'text' as const, key: `storeConfigs.${i}.name` } },
						{ name: tr('Aliases', '别名'), desc: tr('Other names or abbreviations for this store, comma separated. Used when reading schedules.', '这家店的其他叫法或简称，用逗号隔开。读排班时用。'), control: { type: 'text' as const, key: `storeConfigs.${i}.aliases` } },
						{ name: tr('Short label', '简称'), desc: tr('Shown on small calendar chips.', '显示在日历的小胶囊上。'), control: { type: 'text' as const, key: `storeConfigs.${i}.shortName` } },
						{
							type: 'list' as const,
							heading: tr('Wage bands', '时薪段'),
							addItem: { name: tr('Add wage band', '加时薪段'), action: () => {
								const bands = store.wageBands || [];
								const latest = bands[bands.length - 1];
								if (latest) bands.push({ ...latest, effectiveFrom: new Date().toISOString().slice(0, 10) });
								store.wageBands = bands;
								void this.saveAndUpdate();
							} },
							onDelete: (bandIndex: number) => {
								if ((store.wageBands || []).length <= 1) return;
								store.wageBands?.splice(bandIndex, 1);
								void this.saveAndUpdate();
							},
							items: (store.wageBands || []).map((band, j) => ({
								type: 'page' as const,
								name: band.effectiveFrom === '0000-01-01' ? tr('Wage band from the start', '最初的时薪段') : tr(`Wage band from ${band.effectiveFrom}`, `${band.effectiveFrom} 起的时薪段`),
								desc: tr(`Base ¥${band.baseWage}`, `基本 ¥${band.baseWage}`),
								items: [
									{ name: tr('Effective from', '生效日期'), desc: tr('YYYY-MM-DD. Earlier shifts keep the older band.', '格式 YYYY-MM-DD。这天之前的班次仍按旧时薪。'), control: { type: 'text' as const, key: `storeConfigs.${i}.wageBands.${j}.effectiveFrom`, validate: (v: string) => (!v.trim() || /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? undefined : tr('Use YYYY-MM-DD.', '请按 YYYY-MM-DD 填写。')) } },
									...bandLabels().map(({ key, label }) => money(`storeConfigs.${i}.wageBands.${j}.${key}`, label))
								]
							}))
						}
					]
				}))
			},
			{
				type: 'group',
				heading: tr('Payroll and holidays', '工资月与节假日'),
				items: [
					{ name: tr('Payroll month starts on day', '工资月从几号开始'), desc: tr('For example 21 for a 21st-to-20th cycle. Use 1 for calendar months.', '例如 21 表示 21 日到次月 20 日。按自然月填 1。'), control: { type: 'number', key: 'payrollStartDay', min: 1, max: 28, step: 1 } },
					{ name: tr('Extra holidays', '额外假日'), desc: tr('One date (YYYY-MM-DD) per line, paid like a public holiday.', '每行一个日期（YYYY-MM-DD），按法定假日计薪。'), control: { type: 'textarea', key: 'customHolidays', placeholder: '2026-05-01\n2026-12-31' } },
					{ name: tr('Japanese public holidays', '日本法定假日'), desc: tr(`Downloaded from holidays-jp.github.io and cached for a week. Last updated: ${holidayUpdatedText}`, `从 holidays-jp.github.io 下载，缓存一周。上次更新：${holidayUpdatedText}`), render: (setting: Setting) => {
						setting.addButton(button => button.setButtonText(tr('Refresh now', '立即刷新')).onClick(async () => {
							await this.plugin.refreshHolidayCache(true);
							this.update();
						}));
					} }
				]
			},
			{
				type: 'list',
				heading: tr('Income alerts', '收入提醒'),
				emptyState: tr('Income thresholds for tax, social insurance and dependants change from year to year. Enter the amounts that apply to you this year. The plugin only reminds you; it does not work out tax.', '税、社保和扶养的收入门槛每年会变。请填今年适用于你的金额。本插件只做提醒，不计算税额。'),
				addItem: { name: tr('Add income alert', '加收入提醒'), action: () => {
					settings.incomeAlerts.push({ label: tr('Income alert', '收入提醒'), amount: 0, period: 'annual', enabled: true });
					void this.saveAndUpdate();
				} },
				onDelete: index => { settings.incomeAlerts.splice(index, 1); void this.saveAndUpdate(); },
				items: settings.incomeAlerts.map((alert, i) => ({
					type: 'page' as const,
					name: alert.label || tr(`Alert ${i + 1}`, `提醒 ${i + 1}`),
					desc: `${alert.enabled ? '' : tr('Off · ', '已关 · ')}¥${alert.amount.toLocaleString()} ${alert.period === 'annual' ? tr('a year', '每年') : tr('a month', '每月')}`,
					items: [
						{ name: tr('On', '启用'), control: { type: 'toggle' as const, key: `incomeAlerts.${i}.enabled` } },
						{ name: tr('Name', '名称'), control: { type: 'text' as const, key: `incomeAlerts.${i}.label` } },
						{ name: tr('Amount (yen)', '金额（日元）'), control: { type: 'number' as const, key: `incomeAlerts.${i}.amount`, min: 0, step: 1 } },
						{ name: tr('Period', '周期'), desc: tr('Annual counts the calendar year (January to December).', '每年按自然年（1 月到 12 月）计算。'), control: { type: 'dropdown' as const, key: `incomeAlerts.${i}.period`, options: { monthly: tr('Monthly', '每月'), annual: tr('Annual', '每年') } } }
					]
				}))
			},
			{
				type: 'group',
				heading: tr('Hour limits', '工时上限'),
				items: [
					{ name: tr('Long vacations (8 hours a day)', '长假（每天 8 小时）'), desc: tr('One period per line, such as 2026-08-01~2026-09-30. These days are checked against 8 hours each instead of the 28-hour week; a week that mixes term and vacation days counts all its hours toward 28. Use the dates in your school calendar; days you simply have no class do not count.', '每行一段，例如 2026-08-01~2026-09-30。这些日子按每天 8 小时检查，不按每周 28 小时；学期日和长假日混在一起的一周，全部工时都算进 28 小时。请按学校校历填写，只是没课的日子不算长假。'), control: { type: 'textarea', key: 'vacationPeriods', placeholder: '2026-08-01~2026-09-30' } }
				]
			},
			{
				type: 'group',
				heading: tr('Overtime and leave', '加班与休假'),
				items: [
					{ name: tr('Overtime rate', '加班费率'), desc: tr('Multiplier for work over 8 hours a day or 40 hours a week. The legal minimum is 1.25.', '每天超过 8 小时或每周超过 40 小时部分的倍率。法定最低 1.25。'), control: { type: 'number', key: 'overtimeRate', min: 1, step: 0.01 } },
					// The statutory rest day premium is set by law and separate from any store bonus on Sundays.
					{ name: tr('Statutory rest day (法定休日)', '法定休日'), desc: tr('The weekly rest day your employer set in the work rules. Work on that day is paid at the rate below on top of the time bands. Leave it unset if your contract names none.', '雇主在就业规则里定的每周法定休日。在这一天上班，按下面的倍率另加休日劳动割增。合同里没写就保持“未设”。'), control: { type: 'dropdown', key: 'statutoryRestDay', options: weekdays } },
					{ name: tr('Rest day work rate', '休日劳动倍率'), desc: tr('The legal minimum is 1.35.', '法定最低 1.35。'), control: { type: 'number', key: 'restDayWorkRate', min: 1, step: 0.01 } },
					{ name: tr('Paid leave balance', '剩余带薪假'), desc: tr('Days of paid leave (有給休暇) you have left.', '还剩几天带薪假（有給休暇）。'), control: { type: 'number', key: 'paidLeaveBalance', min: 0, step: 0.5 } }
				]
			}
		];
	}

	getControlValue(key: string): unknown {
		const value = readPath(this.plugin.settings, key);
		if (LIST_KEYS.has(key) && Array.isArray(value)) return value.join('\n');
		if (key.endsWith('.aliases') && Array.isArray(value)) return value.join(', ');
		if (key === 'statutoryRestDay') return String(this.plugin.settings.statutoryRestDay);
		if (key.endsWith('.effectiveFrom')) return value === '0000-01-01' ? '' : value;
		return value;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings;
		const field = key.split('.').pop() ?? key;
		if (key === 'calendarName' && !this.plugin.ensureScheduleMutationAllowed()) return;
		let next: unknown = value;
		if (LIST_KEYS.has(key)) next = lines(value);
		else if (field === 'aliases') next = asText(value).split(',').map(alias => alias.trim()).filter(Boolean);
		else if (key === 'statutoryRestDay') next = Number(value);
		else if (field === 'effectiveFrom') next = asText(value).trim() || '0000-01-01';
		else if (field === 'period') next = value === 'annual' ? 'annual' : 'monthly';
		else if (key === 'exportFolder') next = asText(value).trim() || DEFAULT_SETTINGS.exportFolder;
		else if (key === 'payrollStartDay') next = Math.min(28, Math.max(1, Math.floor(Number(value)) || 21));
		else if (key === 'overtimeRate' || key === 'restDayWorkRate') { const rate = Number(value); if (!(rate >= 1)) return; next = rate; }
		else if (typeof value === 'number') next = Math.max(0, value);
		else if (typeof value === 'string' && field !== 'label') next = value.trim();
		if (key === 'aiProvider') {
			// A new service brings its own address and suggested model.
			next = presetFor(asText(value)).id;
			settings.aiBaseUrl = '';
			settings.aiModel = '';
			this.models = undefined;
		}
		writePath(settings, key, next);
		// A renamed store keeps its old name as an alias, so shifts saved under it still match.
		const storeMatch = /^storeConfigs\.(\d+)\.name$/.exec(key);
		if (storeMatch) {
			const store = settings.storeConfigs[Number(storeMatch[1])];
			if (store) store.aliases = Array.from(new Set([store.name, ...store.aliases].filter(Boolean)));
		}
		if (key.startsWith('storeConfigs.')) settings.storeConfigs = normalizeStoreConfigs(settings.storeConfigs);
		await this.plugin.saveSettings();
		this.plugin.refreshDashboards();
		// Names, dates and amounts show on list entries and in the band strip.
		if (/name|label|amount|period|enabled|effectiveFrom|Wage$|^ai/.test(field)) this.update();
	}

	/** Models fetched in this session. */
	private models: string[] | undefined;

	private keyDesc(): DocumentFragment {
		const preset = presetFor(this.plugin.settings.aiProvider);
		const frag = new DocumentFragment();
		frag.appendText(tr('Stored in Obsidian\'s secret storage on this device, not in the plugin\'s settings file, so it does not sync; pick it again on each device. ', '存在本机 Obsidian 的密钥库里，不在插件设置文件中，所以不会随库同步，换设备要重新选一次。'));
		if (preset.keyOptional) frag.appendText(tr('Local servers may not need one.', '本地服务可以不填。'));
		else if (preset.keyUrl) frag.createEl('a', { text: tr(`Get a ${preset.name} key`, `获取 ${preset.name} 密钥`), href: preset.keyUrl });
		return frag;
	}

	private renderModelList(setting: Setting) {
		const settings = this.plugin.settings;
		const models = this.models;
		if (models?.length) {
			const current = settings.aiModel || presetFor(settings.aiProvider).model;
			setting.addDropdown(dropdown => {
				const options: Record<string, string> = { '': tr('Choose a model…', '选择模型…') };
				for (const m of models) options[m] = m;
				dropdown.addOptions(options).setValue(models.includes(current) ? current : '').onChange(value => {
					if (value) void this.setControlValue('aiModel', value);
				});
			});
		}
		setting.addButton(button => button.setButtonText(models ? tr('Fetch again', '重新获取') : tr('Fetch list', '获取列表')).onClick(async () => {
			button.setDisabled(true);
			setting.setDesc(tr('Asking the service…', '正在查询…'));
			try {
				this.models = await listModels(this.plugin.aiTarget());
				this.update();
			} catch (error) {
				setting.setDesc(error instanceof AiError ? error.message : describeFailure('network'));
				button.setDisabled(false);
			}
		}));
	}

	private renderTest(setting: Setting) {
		let diagnostics = '';
		let copyEl: HTMLElement | undefined;
		setting.addButton(button => button.setButtonText(tr('Test', '测试')).onClick(async () => {
			button.setDisabled(true);
			setting.setDesc(tr('Testing…', '测试中…'));
			const result = await testConnection(this.plugin.aiTarget(), `${this.plugin.manifest.name} ${this.plugin.manifest.version}`);
			diagnostics = result.diagnostics;
			setting.setDesc(result.message);
			setting.descEl.toggleClass('mod-warning', !result.ok);
			if (result.models?.length) this.models = result.models;
			copyEl?.toggle(true);
			button.setDisabled(false);
		}));
		setting.addExtraButton(extra => {
			copyEl = extra.extraSettingsEl;
			extra.setIcon('copy').setTooltip(tr('Copy diagnostics (no key, no shift content)', '复制诊断信息（不含密钥和班次内容）')).onClick(() => {
				void navigator.clipboard.writeText(diagnostics).then(() => new Notice(tr('Diagnostics copied. They contain no key and no shift content.', '诊断信息已复制，不含密钥和班次内容。')));
			});
		});
		copyEl?.toggle(false);
	}

	private async saveAndUpdate() {
		this.plugin.settings.storeConfigs = normalizeStoreConfigs(this.plugin.settings.storeConfigs);
		await this.plugin.saveSettings();
		this.update();
	}

	/** One strip for the whole day, so a missing or odd band is easy to spot. */
	private drawBandStrip(setting: Setting) {
		const settings = this.plugin.settings;
		setting.settingEl.addClass('jws-band-row');
		setting.infoEl.remove();
		const band = setting.controlEl.createDiv({ cls: 'jws-band' });
		const strip = band.createDiv({ cls: 'jws-band-strip' });
		[
			{ name: tr('Morning', '早班'), wage: settings.morningWage, hours: 4, cls: 'is-morning' },
			{ name: tr('Base', '基本'), wage: settings.baseWage, hours: 8, cls: 'is-base' },
			{ name: tr('Evening', '晚班'), wage: settings.eveningWage, hours: 5, cls: 'is-evening' },
			{ name: tr('Night', '深夜'), wage: settings.nightWage, hours: 7, cls: 'is-night' }
		].forEach(part => {
			const seg = strip.createDiv({ cls: `jws-band-seg ${part.cls}` });
			seg.setCssProps({ '--jws-grow': String(part.hours) });
			seg.createDiv({ cls: 'jws-band-wage', text: `¥${Number(part.wage).toLocaleString()}` });
			seg.createDiv({ cls: 'jws-band-name', text: part.name });
		});
		const ticks = band.createDiv({ cls: 'jws-band-ticks' });
		['05:00', '09:00', '17:00', '22:00', '05:00'].forEach(tick => ticks.createSpan({ text: tick }));
	}
}
