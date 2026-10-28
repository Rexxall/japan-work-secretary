import { App, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import JapanWorkSecretaryPlugin from './main';
import { EffectiveWageBandConfig, StoreConfig, WageBandConfig, cloneDefaultStoreConfigs, normalizeStoreConfigs } from './data';

export interface IncomeAlert {
	label: string;
	amount: number; // JPY
	period: 'monthly' | 'annual';
	enabled: boolean;
}

export const DEFAULT_INCOME_ALERTS: IncomeAlert[] = [
	{ label: 'Monthly income alert', amount: 88000, period: 'monthly', enabled: false },
	{ label: 'Annual income alert 1', amount: 1030000, period: 'annual', enabled: false },
	{ label: 'Annual income alert 2', amount: 1300000, period: 'annual', enabled: false }
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
	paperStyle: boolean;
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
	paperStyle: false
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

		containerEl.addClass('jws-settings');
		const tabHeader = containerEl.createDiv({ cls: 'rk-seg jws-settings-tabs' });
		const generalSec = containerEl.createDiv();
		const wageSec = containerEl.createDiv();
		const legalSec = containerEl.createDiv();

		const sections = [
			{ name: 'General', el: generalSec },
			{ name: 'Wage rates', el: wageSec },
			{ name: 'Compliance & cycle', el: legalSec }
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

		new Setting(generalSec)
			.setName('Paper and ink style')
			.setDesc('Paper background, ink lines and serif numbers. Off follows your theme.')
			.addToggle(toggle => toggle
				.setValue(!!this.plugin.settings.paperStyle)
				.onChange(async (value) => {
					this.plugin.settings.paperStyle = value;
					await this.plugin.saveSettings();
					this.plugin.refreshDashboards();
				}));

		// --- GENERAL TAB ---
		new Setting(generalSec)
			.setName('Gemini API key')
			.setDesc('Optional, for reading shifts from text or photos. Choose or create a secret in Obsidian\'s secret storage; other plugins can use the same one.')
			.addComponent(el => new SecretComponent(this.app, el)
				.setValue(this.plugin.settings.geminiSecretName)
				.onChange(async value => {
					this.plugin.settings.geminiSecretName = value ?? '';
					await this.plugin.saveSettings();
				}));

		new Setting(generalSec)
			.setName('macOS Calendar name')
			.setDesc('Target calendar in macOS Calendar. Changing it syncs into the new calendar; existing events in the previous calendar are not removed automatically.')
			.addText(text => text
				.setPlaceholder('Work')
				.setValue(this.plugin.settings.calendarName)
				.onChange(async (value) => {
					if (!this.plugin.ensureScheduleMutationAllowed()) return;
					this.plugin.settings.calendarName = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(generalSec)
			.setName('Event title prefix')
			.setDesc('Calendar events are titled "<prefix>: <store>". Existing events are matched by a hidden marker, so changing this only renames them on the next sync.')
			.addText(text => text
				.setPlaceholder('打工')
				.setValue(this.plugin.settings.eventTitlePrefix)
				.onChange(async (value) => {
					this.plugin.settings.eventTitlePrefix = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(generalSec)
			.setName('Export folder')
			.setDesc('Where pay notes and .ics calendar files are saved.')
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.exportFolder)
				.setValue(this.plugin.settings.exportFolder)
				.onChange(async (value) => {
					this.plugin.settings.exportFolder = value.trim() || DEFAULT_SETTINGS.exportFolder;
					await this.plugin.saveSettings();
				}));

		// --- WAGE RATES TAB ---
		new Setting(wageSec).setName('Default wage bands').setHeading();
		// One strip for the whole day, so a missing or odd band is easy to spot.
		const band = wageSec.createDiv({ cls: 'jws-band' });
		const drawBand = () => {
			band.empty();
			const settings = this.plugin.settings;
			const strip = band.createDiv({ cls: 'jws-band-strip' });
			[
				{ name: 'Morning', wage: settings.morningWage, hours: 3, cls: 'is-morning' },
				{ name: 'Base', wage: settings.baseWage, hours: 8, cls: 'is-base' },
				{ name: 'Evening', wage: settings.eveningWage, hours: 5, cls: 'is-evening' },
				{ name: 'Night', wage: settings.nightWage, hours: 3, cls: 'is-night' }
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
			.setName('Base wage (09:00–17:00)')
			.addText(text => text
				.setValue(this.plugin.settings.baseWage.toString())
				.onChange(async (value) => {
					this.plugin.settings.baseWage = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(wageSec)
			.setName('Morning wage (opening–09:00)')
			.addText(text => text
				.setValue(this.plugin.settings.morningWage.toString())
				.onChange(async (value) => {
					this.plugin.settings.morningWage = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(wageSec)
			.setName('Evening wage (17:00–22:00)')
			.addText(text => text
				.setValue(this.plugin.settings.eveningWage.toString())
				.onChange(async (value) => {
					this.plugin.settings.eveningWage = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(wageSec)
			.setName('Night wage (22:00–closing)')
			.addText(text => text
				.setValue(this.plugin.settings.nightWage.toString())
				.onChange(async (value) => {
					this.plugin.settings.nightWage = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(wageSec)
			.setName('Sunday and holiday bonus per hour')
			.addText(text => text
				.setValue(this.plugin.settings.holidayBonus.toString())
				.onChange(async (value) => {
					this.plugin.settings.holidayBonus = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(wageSec)
			.setName('Daily commuting allowance')
			.setDesc('Added to your wage for each workday.')
			.addText(text => text
				.setPlaceholder('500')
				.setValue(this.plugin.settings.commutingAllowance.toString())
				.onChange(async (value) => {
					this.plugin.settings.commutingAllowance = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(wageSec).setName('Wage bands by store').setHeading();
		wageSec.createEl('p', {
			text: 'Each store can override the default wage bands above.',
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
				.setName('Store name')
				.addText(text => text
					.setValue(store.name)
					.onChange(async (value) => {
						await updateStoreConfig(index, {
							name: value.trim() || store.name,
							aliases: Array.from(new Set([value.trim(), ...store.aliases].filter(Boolean)))
						});
					}));

			new Setting(storeBox)
				.setName('Aliases')
				.setDesc('Other names or abbreviations for this store, comma separated. Used when reading schedules.')
				.addTextArea(text => text
					.setValue(store.aliases.join(', '))
					.onChange(async (value) => {
						await updateStoreConfig(index, {
							aliases: value.split(',').map(alias => alias.trim()).filter(Boolean)
						});
					}));

			new Setting(storeBox)
				.setName('Short label')
				.setDesc('Shown on small calendar chips.')
				.addText(text => text
					.setValue(store.shortName || store.name)
					.onChange(async (value) => {
						await updateStoreConfig(index, { shortName: value.trim() || store.name });
					}));

			(store.wageBands || []).forEach((band, bandIndex) => {
				const bandBox = storeBox.createDiv({ cls: 'jws-band-box' });
				new Setting(bandBox).setName(band.effectiveFrom === '0000-01-01' ? 'Wage band from the start' : `Wage band from ${band.effectiveFrom}`).setHeading();

				new Setting(bandBox)
					.setName('Effective from')
					.addText(text => {
						text.inputEl.type = 'date';
						text.setValue(band.effectiveFrom === '0000-01-01' ? '' : band.effectiveFrom)
							.onChange(async (value) => {
								await updateWageBand(index, bandIndex, { effectiveFrom: value || '0000-01-01' });
								this.display();
							});
					});

				[
					{ key: 'baseWage', label: 'Base wage (09:00–17:00)' },
					{ key: 'morningWage', label: 'Morning wage (opening–09:00)' },
					{ key: 'eveningWage', label: 'Evening wage (17:00–22:00)' },
					{ key: 'nightWage', label: 'Night wage (22:00–closing)' },
					{ key: 'holidayBonus', label: 'Sunday and holiday bonus per hour' },
					{ key: 'commutingAllowance', label: 'Daily commuting allowance' }
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
						.setName('Remove this wage band')
						.addButton(button => button
							.setButtonText('Remove')
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
				.setName('Add wage band')
				.setDesc('When your hourly wage changes from a certain date. Earlier shifts keep the old rates.')
				.addButton(button => button
					.setButtonText('Add')
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
		new Setting(legalSec).setName('Payroll and holidays').setHeading();

		new Setting(legalSec)
			.setName('Payroll month starts on day')
			.setDesc('For example 21 for a 21st-to-20th cycle. Use 1 for calendar months.')
			.addText(text => text
				.setPlaceholder('21')
				.setValue((this.plugin.settings.payrollStartDay || 21).toString())
				.onChange(async (value) => {
					this.plugin.settings.payrollStartDay = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(legalSec)
			.setName('Extra holidays')
			.setDesc('One date (YYYY-MM-DD) per line, paid like a public holiday.')
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
			.setName('Japanese public holidays')
			.setDesc(`Downloaded from holidays-jp.github.io and cached for a week. Last updated: ${holidayUpdatedText}`)
			.addButton(button => button
				.setButtonText('Refresh now')
				.onClick(async () => {
					await this.plugin.refreshHolidayCache(true);
					this.display();
				}));

		new Setting(legalSec).setName('Income alerts').setHeading();
		legalSec.createEl('p', {
			text: 'Income thresholds for tax, social insurance and dependants change from year to year. Enter the amounts that apply to you this year. The plugin only reminds you; it does not work out tax.',
			cls: 'setting-item-description'
		});
		this.plugin.settings.incomeAlerts.forEach((alert, index) => {
			new Setting(legalSec)
				.setName(alert.label || `Alert ${index + 1}`)
				.setDesc(alert.period === 'annual' ? 'Income for the calendar year (January to December).' : 'Income for the current month.')
				.addText(text => text
					.setPlaceholder('Name')
					.setValue(alert.label)
					.onChange(async (value) => {
						alert.label = value.trim();
						await this.plugin.saveSettings();
					}))
				.addText(text => {
					text.inputEl.type = 'number';
					text.setPlaceholder('Amount (yen)')
						.setValue(String(alert.amount || ''))
						.onChange(async (value) => {
							alert.amount = Math.max(0, Number(value) || 0);
							await this.plugin.saveSettings();
						});
				})
				.addDropdown(dropdown => dropdown
					.addOption('monthly', 'Monthly')
					.addOption('annual', 'Annual')
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
			.setName('Long vacations (8 hours a day)')
			.setDesc('One period per line, such as 2026-08-01~2026-09-30. These days are checked against 8 hours each instead of the 28-hour week. Use the dates in your school calendar; days you simply have no class do not count.')
			.addTextArea(text => text
				.setPlaceholder('2026-08-01~2026-09-30')
				.setValue((this.plugin.settings.vacationPeriods || []).join('\n'))
				.onChange(async (value) => {
					this.plugin.settings.vacationPeriods = value.split('\n').map(line => line.trim()).filter(Boolean);
					await this.plugin.saveSettings();
				}));

		new Setting(legalSec).setName('Overtime and leave').setHeading();

		new Setting(legalSec)
			.setName('Overtime rate')
			.setDesc('Multiplier for work over 8 hours a day or 40 hours a week. The legal minimum is 1.25.')
			.addText(text => text
				.setValue(this.plugin.settings.overtimeRate.toString())
				.onChange(async (value) => {
					this.plugin.settings.overtimeRate = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(legalSec)
			.setName('Paid leave balance')
			.setDesc('Days of paid leave (有給休暇) you have left.')
			.addText(text => text
				.setValue(this.plugin.settings.paidLeaveBalance.toString())
				.onChange(async (value) => {
					this.plugin.settings.paidLeaveBalance = Number(value);
					await this.plugin.saveSettings();
				}));
	}
}
