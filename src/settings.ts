import { App, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import { tr } from './i18n';
import JapanWorkSecretaryPlugin from './main';
import { EffectiveWageBandConfig, StoreConfig, WageBandConfig, cloneDefaultStoreConfigs, normalizeStoreConfigs } from './data';

export interface IncomeAlert {
	label: string;
	amount: number; // JPY
	period: 'monthly' | 'annual';
	enabled: boolean;
}

export const DEFAULT_INCOME_ALERTS: IncomeAlert[] = [
	{ label: tr('Monthly income alert', '月收入提醒'), amount: 88000, period: 'monthly', enabled: false },
	{ label: tr('Annual income alert 1', '年收入提醒 1'), amount: 1030000, period: 'annual', enabled: false },
	{ label: tr('Annual income alert 2', '年收入提醒 2'), amount: 1300000, period: 'annual', enabled: false }
];

export function migrateIncomeAlerts(settings: Partial<JapanWorkSecretarySettings>): IncomeAlert[] {
	if (Array.isArray(settings.incomeAlerts) && settings.incomeAlerts.length > 0) {
		return settings.incomeAlerts.map(alert => ({
			label: alert.label || 'Income alert',
			amount: Number(alert.amount) || 0,
			period: alert.period === 'annual' ? 'annual' : 'monthly',
			enabled: !!alert.enabled
		}));
	}
	const legacy = [settings.taxWall88k, settings.taxWall103k, settings.taxWall130k];
	return DEFAULT_INCOME_ALERTS.map((alert, index) => ({
		...alert,
		enabled: typeof legacy[index] === 'boolean' ? !!legacy[index] : alert.enabled
	}));
}

export interface JapanWorkSecretarySettings {
	/** Name of the secret in Obsidian's secret storage that holds the Gemini key. */
	geminiSecretName: string;
	// Before 1.4.0; migrated into secret storage on load.
	geminiApiKey: string;
	useMacKeychainForGeminiApiKey: boolean;
	calendarName: string;
	storeConfigs: StoreConfig[];
	baseWage: number;
	morningWage: number; // 开店～9:00
	eveningWage: number; // 17:00～22:00
	nightWage: number; // 22:00～閉店
	holidayBonus: number; // 日・祝日
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
	geminiSecretName: '',
	geminiApiKey: '',
	useMacKeychainForGeminiApiKey: false,
	calendarName: 'Work',
	storeConfigs: cloneDefaultStoreConfigs(),
	baseWage: 1370,
	morningWage: 1510,
	eveningWage: 1440,
	nightWage: 1720,
	holidayBonus: 50,
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

export class JapanWorkSecretarySettingTab extends PluginSettingTab {
	plugin: JapanWorkSecretaryPlugin;

	constructor(app: App, plugin: JapanWorkSecretaryPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.addClass('jws-settings', 'ap', 'ap-settings');
		const tabHeader = containerEl.createDiv({ cls: 'ap-seg jws-settings-tabs' });
		const generalSec = containerEl.createDiv();
		const wageSec = containerEl.createDiv();
		const legalSec = containerEl.createDiv();

		const sections = [
			{ name: tr('General', '常规'), el: generalSec },
			{ name: tr('Wage rates', '时薪'), el: wageSec },
			{ name: tr('Compliance & cycle', '规则与周期'), el: legalSec }
		];

		const btns: HTMLButtonElement[] = [];
		const show = (index: number) => {
			sections.forEach((section, i) => section.el.toggle(i === index));
			btns.forEach((button, i) => button.toggleClass('is-active', i === index));
		};
		sections.forEach((sec, idx) => {
			const btn = tabHeader.createEl('button', { text: sec.name });
			btns.push(btn);
			btn.onClickEvent(() => show(idx));
		});
		show(0);

		// --- GENERAL TAB ---
		new Setting(generalSec)
			.setName(tr('Gemini API key', 'Gemini API 密钥'))
			.setDesc(tr('Optional, for reading shifts from text or photos. Choose or create a secret in Obsidian\'s secret storage; other plugins can use the same one.', '可不填，用于从文字或照片读取班次。在 Obsidian 的密钥库里选择或新建，其他插件也能共用。'))
			.addComponent(el => new SecretComponent(this.app, el)
				.setValue(this.plugin.settings.geminiSecretName)
				.onChange(async value => {
					this.plugin.settings.geminiSecretName = value ?? '';
					await this.plugin.saveSettings();
				}));

		new Setting(generalSec)
			.setName(tr('macOS Calendar name', 'macOS 日历名称'))
			.setDesc(tr('Target calendar in macOS Calendar. Changing it syncs into the new calendar; existing events in the previous calendar are not removed automatically.', '写入 macOS 日历里的哪个日历。改了以后同步到新日历，旧日历里已有的事件不会自动删除。'))
			.addText(text => text
				.setPlaceholder('Work')
				.setValue(this.plugin.settings.calendarName)
				.onChange(async (value) => {
					if (!this.plugin.ensureScheduleMutationAllowed()) return;
					this.plugin.settings.calendarName = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(generalSec)
			.setName(tr('Event title prefix', '事件标题前缀'))
			.setDesc(tr('Calendar events are titled "<prefix>: <store>". Existing events are matched by a hidden marker, so changing this only renames them on the next sync.', '日历事件标题为“前缀: 店名”。已有事件靠隐藏标记识别，改前缀只会在下次同步时改名。'))
			.addText(text => text
				.setPlaceholder('打工')
				.setValue(this.plugin.settings.eventTitlePrefix)
				.onChange(async (value) => {
					this.plugin.settings.eventTitlePrefix = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(generalSec)
			.setName(tr('Export folder', '导出文件夹'))
			.setDesc(tr('Where pay notes and .ics calendar files are saved.', '工资笔记和 .ics 日历文件的保存位置。'))
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.exportFolder)
				.setValue(this.plugin.settings.exportFolder)
				.onChange(async (value) => {
					this.plugin.settings.exportFolder = value.trim() || DEFAULT_SETTINGS.exportFolder;
					await this.plugin.saveSettings();
				}));

		// --- WAGE RATES TAB ---
		new Setting(wageSec).setName(tr('Default wage bands', '默认时薪段')).setHeading();
		// One strip for the whole day, so a missing or odd band is easy to spot.
		const band = wageSec.createDiv({ cls: 'jws-band' });
		const drawBand = () => {
			band.empty();
			const settings = this.plugin.settings;
			const strip = band.createDiv({ cls: 'jws-band-strip' });
			[
				{ name: tr('Morning', '早班'), wage: settings.morningWage, hours: 3, cls: 'is-morning' },
				{ name: tr('Base', '基本'), wage: settings.baseWage, hours: 8, cls: 'is-base' },
				{ name: tr('Evening', '晚班'), wage: settings.eveningWage, hours: 5, cls: 'is-evening' },
				{ name: tr('Night', '深夜'), wage: settings.nightWage, hours: 3, cls: 'is-night' }
			].forEach(part => {
				const seg = strip.createDiv({ cls: `jws-band-seg ${part.cls}` });
				seg.setCssProps({ '--jws-grow': String(part.hours) });
				seg.createDiv({ cls: 'jws-band-wage', text: `¥${Number(part.wage).toLocaleString()}` });
				seg.createDiv({ cls: 'jws-band-name', text: part.name });
			});
			const ticks = band.createDiv({ cls: 'jws-band-ticks' });
			['open', '09:00', '17:00', '22:00', 'close'].forEach(tick => ticks.createSpan({ text: tick }));
		};
		drawBand();
		wageSec.addEventListener('input', () => window.setTimeout(drawBand, 0));

		new Setting(wageSec)
			.setName(tr('Base wage (09:00–17:00)', '基本时薪（09:00–17:00）'))
			.addText(text => text
				.setValue(this.plugin.settings.baseWage.toString())
				.onChange(async (value) => {
					this.plugin.settings.baseWage = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(wageSec)
			.setName(tr('Morning wage (opening–09:00)', '早班时薪（开店–09:00）'))
			.addText(text => text
				.setValue(this.plugin.settings.morningWage.toString())
				.onChange(async (value) => {
					this.plugin.settings.morningWage = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(wageSec)
			.setName(tr('Evening wage (17:00–22:00)', '晚班时薪（17:00–22:00）'))
			.addText(text => text
				.setValue(this.plugin.settings.eveningWage.toString())
				.onChange(async (value) => {
					this.plugin.settings.eveningWage = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(wageSec)
			.setName(tr('Night wage (22:00–closing)', '深夜时薪（22:00–闭店）'))
			.addText(text => text
				.setValue(this.plugin.settings.nightWage.toString())
				.onChange(async (value) => {
					this.plugin.settings.nightWage = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(wageSec)
			.setName(tr('Sunday and holiday bonus per hour', '周日和节假日每小时加给'))
			.addText(text => text
				.setValue(this.plugin.settings.holidayBonus.toString())
				.onChange(async (value) => {
					this.plugin.settings.holidayBonus = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(wageSec)
			.setName(tr('Daily commuting allowance', '每日交通费'))
			.setDesc(tr('Added to your wage for each workday.', '每个上班日加到工资里。'))
			.addText(text => text
				.setPlaceholder('500')
				.setValue(this.plugin.settings.commutingAllowance.toString())
				.onChange(async (value) => {
					this.plugin.settings.commutingAllowance = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(wageSec).setName(tr('Wage bands by store', '各店时薪段')).setHeading();
		wageSec.createEl('p', {
			text: tr('Each store can override the default wage bands above.', '每家店可以单独设时薪，覆盖上面的默认值。'),
			cls: 'setting-item-description'
		});

		this.plugin.settings.storeConfigs = normalizeStoreConfigs(this.plugin.settings.storeConfigs);

		const updateStoreConfig = async (index: number, patch: Partial<StoreConfig>) => {
			const stores = normalizeStoreConfigs(this.plugin.settings.storeConfigs);
			stores[index] = {
				...stores[index],
				...patch,
				aliases: patch.aliases || stores[index].aliases
			};
			this.plugin.settings.storeConfigs = normalizeStoreConfigs(stores);
			await this.plugin.saveSettings();
		};

		const updateWageBand = async (storeIndex: number, bandIndex: number, patch: Partial<EffectiveWageBandConfig>) => {
			const stores = normalizeStoreConfigs(this.plugin.settings.storeConfigs);
			const wageBands = [...(stores[storeIndex].wageBands || [])];
			wageBands[bandIndex] = {
				...wageBands[bandIndex],
				...patch
			};
			await updateStoreConfig(storeIndex, { wageBands });
		};

		this.plugin.settings.storeConfigs.forEach((store, index) => {
			const storeBox = wageSec.createDiv({ cls: 'jws-store-box' });
			new Setting(storeBox).setName(store.name).setHeading();

			new Setting(storeBox)
				.setName(tr('Store name', '店名'))
				.addText(text => text
					.setValue(store.name)
					.onChange(async (value) => {
						await updateStoreConfig(index, {
							name: value.trim() || store.name,
							aliases: Array.from(new Set([value.trim(), ...store.aliases].filter(Boolean)))
						});
					}));

			new Setting(storeBox)
				.setName(tr('Aliases', '别名'))
				.setDesc(tr('Other names or abbreviations for this store, comma separated. Used when reading schedules.', '这家店的其他叫法或简称，用逗号隔开。读排班时用。'))
				.addTextArea(text => text
					.setValue(store.aliases.join(', '))
					.onChange(async (value) => {
						await updateStoreConfig(index, {
							aliases: value.split(',').map(alias => alias.trim()).filter(Boolean)
						});
					}));

			new Setting(storeBox)
				.setName(tr('Short label', '简称'))
				.setDesc(tr('Shown on small calendar chips.', '显示在日历的小胶囊上。'))
				.addText(text => text
					.setValue(store.shortName || store.name)
					.onChange(async (value) => {
						await updateStoreConfig(index, { shortName: value.trim() || store.name });
					}));

			(store.wageBands || []).forEach((band, bandIndex) => {
				const bandBox = storeBox.createDiv({ cls: 'jws-band-box' });
				new Setting(bandBox).setName(band.effectiveFrom === '0000-01-01' ? tr('Wage band from the start', '最初的时薪段') : tr(`Wage band from ${band.effectiveFrom}`, `${band.effectiveFrom} 起的时薪段`)).setHeading();

				new Setting(bandBox)
					.setName(tr('Effective from', '生效日期'))
					.addText(text => {
						text.inputEl.type = 'date';
						text.setValue(band.effectiveFrom === '0000-01-01' ? '' : band.effectiveFrom)
							.onChange(async (value) => {
								await updateWageBand(index, bandIndex, { effectiveFrom: value || '0000-01-01' });
								this.display();
							});
					});

				[
					{ key: 'baseWage', label: tr('Base wage (09:00–17:00)', '基本时薪（09:00–17:00）') },
					{ key: 'morningWage', label: tr('Morning wage (opening–09:00)', '早班时薪（开店–09:00）') },
					{ key: 'eveningWage', label: tr('Evening wage (17:00–22:00)', '晚班时薪（17:00–22:00）') },
					{ key: 'nightWage', label: tr('Night wage (22:00–closing)', '深夜时薪（22:00–闭店）') },
					{ key: 'holidayBonus', label: tr('Sunday and holiday bonus per hour', '周日和节假日每小时加给') },
					{ key: 'commutingAllowance', label: tr('Daily commuting allowance', '每日交通费') }
				].forEach(({ key, label }) => {
					new Setting(bandBox)
						.setName(label)
						.addText(text => text
							.setValue(String(band[key as keyof WageBandConfig] ?? 0))
							.onChange(async (value) => {
								await updateWageBand(index, bandIndex, { [key]: Number(value) });
							}));
				});

				if ((store.wageBands || []).length > 1) {
					new Setting(bandBox)
						.setName(tr('Remove this wage band', '删除这个时薪段'))
						.addButton(button => button
							.setButtonText(tr('Remove', '删除'))
							.onClick(async () => {
								const stores = normalizeStoreConfigs(this.plugin.settings.storeConfigs);
								const wageBands = [...(stores[index].wageBands || [])];
								wageBands.splice(bandIndex, 1);
								await updateStoreConfig(index, { wageBands });
								this.display();
							}));
				}
			});

			new Setting(storeBox)
				.setName(tr('Add wage band', '加时薪段'))
				.setDesc(tr('When your hourly wage changes from a certain date. Earlier shifts keep the old rates.', '时薪从某天起变化时用。之前的班次仍按旧时薪。'))
				.addButton(button => button
					.setButtonText(tr('Add', '添加'))
					.onClick(async () => {
						const stores = normalizeStoreConfigs(this.plugin.settings.storeConfigs);
						const wageBands = [...(stores[index].wageBands || [])];
						const latestBand = wageBands[wageBands.length - 1];
						wageBands.push({
							...latestBand,
							effectiveFrom: new Date().toISOString().slice(0, 10)
						});
						await updateStoreConfig(index, { wageBands });
						this.display();
					}));
		});

		// --- COMPLIANCE TAB ---
		new Setting(legalSec).setName(tr('Payroll and holidays', '工资月与节假日')).setHeading();

		new Setting(legalSec)
			.setName(tr('Payroll month starts on day', '工资月从几号开始'))
			.setDesc(tr('For example 21 for a 21st-to-20th cycle. Use 1 for calendar months.', '例如 21 表示 21 日到次月 20 日。按自然月填 1。'))
			.addText(text => text
				.setPlaceholder('21')
				.setValue((this.plugin.settings.payrollStartDay || 21).toString())
				.onChange(async (value) => {
					this.plugin.settings.payrollStartDay = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(legalSec)
			.setName(tr('Extra holidays', '额外假日'))
			.setDesc(tr('One date (YYYY-MM-DD) per line, paid like a public holiday.', '每行一个日期（YYYY-MM-DD），按法定假日计薪。'))
			.addTextArea(text => text
				.setPlaceholder('2026-05-01\n2026-12-31')
				.setValue((this.plugin.settings.customHolidays || []).join('\n'))
				.onChange(async (value) => {
					this.plugin.settings.customHolidays = value.split('\n').map(d => d.trim()).filter(d => d.length > 0);
					await this.plugin.saveSettings();
				}));

		const holidayUpdatedText = this.plugin.settings.holidayCacheUpdatedAt
			? new Date(this.plugin.settings.holidayCacheUpdatedAt).toLocaleString()
			: 'never';

		new Setting(legalSec)
			.setName(tr('Japanese public holidays', '日本法定假日'))
			.setDesc(tr(`Downloaded from holidays-jp.github.io and cached for a week. Last updated: ${holidayUpdatedText}`, `从 holidays-jp.github.io 下载，缓存一周。上次更新：${holidayUpdatedText}`))
			.addButton(button => button
				.setButtonText(tr('Refresh now', '立即刷新'))
				.onClick(async () => {
					await this.plugin.refreshHolidayCache(true);
					this.display();
				}));

		new Setting(legalSec).setName(tr('Income alerts', '收入提醒')).setHeading();
		legalSec.createEl('p', {
			text: tr('Income thresholds for tax, social insurance and dependants change from year to year. Enter the amounts that apply to you this year. The plugin only reminds you; it does not work out tax.', '税、社保和扶养的收入门槛每年会变。请填今年适用于你的金额。本插件只做提醒，不计算税额。'),
			cls: 'setting-item-description'
		});
		this.plugin.settings.incomeAlerts.forEach((alert, index) => {
			new Setting(legalSec)
				.setName(alert.label || `Alert ${index + 1}`)
				.setDesc(alert.period === 'annual' ? tr('Income for the calendar year (January to December).', '自然年（1 月到 12 月）的收入。') : tr('Income for the current month.', '当月的收入。'))
				.addText(text => text
					.setPlaceholder(tr('Name', '名称'))
					.setValue(alert.label)
					.onChange(async (value) => {
						alert.label = value.trim();
						await this.plugin.saveSettings();
					}))
				.addText(text => {
					text.inputEl.type = 'number';
					text.setPlaceholder(tr('Amount (yen)', '金额（日元）'))
						.setValue(String(alert.amount || ''))
						.onChange(async (value) => {
							alert.amount = Math.max(0, Number(value) || 0);
							await this.plugin.saveSettings();
						});
				})
				.addDropdown(dropdown => dropdown
					.addOption('monthly', tr('Monthly', '每月'))
					.addOption('annual', tr('Annual', '每年'))
					.setValue(alert.period)
					.onChange(async (value) => {
						alert.period = value === 'annual' ? 'annual' : 'monthly';
						await this.plugin.saveSettings();
						this.display();
					}))
				.addToggle(toggle => toggle
					.setValue(alert.enabled)
					.onChange(async (value) => {
						alert.enabled = value;
						await this.plugin.saveSettings();
					}));
		});

		new Setting(legalSec)
			.setName(tr('Long vacations (8 hours a day)', '长假（每天 8 小时）'))
			.setDesc(tr('One period per line, such as 2026-08-01~2026-09-30. These days are checked against 8 hours each instead of the 28-hour week; a week that mixes term and vacation days counts all its hours toward 28. Use the dates in your school calendar; days you simply have no class do not count.', '每行一段，例如 2026-08-01~2026-09-30。这些日子按每天 8 小时检查，不按每周 28 小时；学期日和长假日混在一起的一周，全部工时都算进 28 小时。请按学校校历填写，只是没课的日子不算长假。'))
			.addTextArea(text => text
				.setPlaceholder('2026-08-01~2026-09-30')
				.setValue((this.plugin.settings.vacationPeriods || []).join('\n'))
				.onChange(async (value) => {
					this.plugin.settings.vacationPeriods = value.split('\n').map(line => line.trim()).filter(Boolean);
					await this.plugin.saveSettings();
				}));

		new Setting(legalSec).setName(tr('Overtime and leave', '加班与休假')).setHeading();

		new Setting(legalSec)
			.setName(tr('Overtime rate', '加班费率'))
			.setDesc(tr('Multiplier for work over 8 hours a day or 40 hours a week. The legal minimum is 1.25.', '每天超过 8 小时或每周超过 40 小时部分的倍率。法定最低 1.25。'))
			.addText(text => text
				.setValue(this.plugin.settings.overtimeRate.toString())
				.onChange(async (value) => {
					this.plugin.settings.overtimeRate = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(legalSec)
			.setName(tr('Paid leave balance', '剩余带薪假'))
			.setDesc(tr('Days of paid leave (有給休暇) you have left.', '还剩几天带薪假（有給休暇）。'))
			.addText(text => text
				.setValue(this.plugin.settings.paidLeaveBalance.toString())
				.onChange(async (value) => {
					this.plugin.settings.paidLeaveBalance = Number(value);
					await this.plugin.saveSettings();
				}));
	}
}
