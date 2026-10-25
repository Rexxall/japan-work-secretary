import { App, PluginSettingTab, Setting } from 'obsidian';
import JapanWorkSecretaryPlugin from './main';
import { EffectiveWageBandConfig, StoreConfig, cloneDefaultStoreConfigs, normalizeStoreConfigs } from './data';

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
	geminiApiKey: '',
	useMacKeychainForGeminiApiKey: true,
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
		containerEl.createEl('h2', { text: 'Japan Work Secretary' });

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
			.setName('Paper & ink style')
			.setDesc('Paper background, ink lines and serif numbers. Off follows your Obsidian theme.')
			.addToggle(toggle => toggle
				.setValue(!!this.plugin.settings.paperStyle)
				.onChange(async (value) => {
					this.plugin.settings.paperStyle = value;
					await this.plugin.saveSettings();
					this.plugin.refreshDashboards();
				}));

		// --- GENERAL TAB ---
		new Setting(generalSec)
			.setName('Gemini API Key')
			.setDesc(this.plugin.settings.useMacKeychainForGeminiApiKey
				? 'Stored in macOS Keychain; data.json keeps only a blank placeholder.'
				: 'Stored in data.json. Keychain storage is recommended.')
			.addText(text => {
				text.inputEl.type = 'password';
				text.setPlaceholder(this.plugin.getGeminiApiKey() ? 'Saved' : 'Enter your API Key')
				.setValue('')
				.onChange(async (value) => {
					if (value.trim()) {
						await this.plugin.setGeminiApiKey(value.trim());
					}
				});
			});

		new Setting(generalSec)
			.setName('Store Gemini API Key in macOS Keychain')
			.setDesc('Recommended. Existing plaintext key will be migrated on plugin load or when you paste a new key above.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.useMacKeychainForGeminiApiKey)
				.onChange(async (value) => {
					this.plugin.settings.useMacKeychainForGeminiApiKey = value;
					const existingKey = this.plugin.getGeminiApiKey();
					if (value && existingKey) {
						await this.plugin.setGeminiApiKey(existingKey);
					} else {
						await this.plugin.saveSettings();
					}
					this.display();
				}));

		new Setting(generalSec)
			.setName('Apple Calendar Name')
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
			.setName('Event Title Prefix')
			.setDesc('Calendar events are titled "<prefix>: <store>". Existing events are matched by a hidden marker, so changing this only renames them on the next sync.')
			.addText(text => text
				.setPlaceholder('打工')
				.setValue(this.plugin.settings.eventTitlePrefix)
				.onChange(async (value) => {
					this.plugin.settings.eventTitlePrefix = value.trim();
					await this.plugin.saveSettings();
				}));

		// --- WAGE RATES TAB ---
		wageSec.createEl('h3', {text: 'Default wage bands'});
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
				seg.style.flexGrow = String(part.hours);
				seg.createDiv({ cls: 'jws-band-wage', text: `¥${Number(part.wage).toLocaleString()}` });
				seg.createDiv({ cls: 'jws-band-name', text: part.name });
			});
			const ticks = band.createDiv({ cls: 'jws-band-ticks' });
			['open', '09:00', '17:00', '22:00', 'close'].forEach(tick => ticks.createSpan({ text: tick }));
		};
		drawBand();
		wageSec.addEventListener('input', () => window.setTimeout(drawBand, 0));

		new Setting(wageSec)
			.setName('Base Wage (09:00 - 17:00)')
			.addText(text => text
				.setValue(this.plugin.settings.baseWage.toString())
				.onChange(async (value) => {
					this.plugin.settings.baseWage = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(wageSec)
			.setName('Morning Wage (Open - 09:00)')
			.addText(text => text
				.setValue(this.plugin.settings.morningWage.toString())
				.onChange(async (value) => {
					this.plugin.settings.morningWage = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(wageSec)
			.setName('Evening Wage (17:00 - 22:00)')
			.addText(text => text
				.setValue(this.plugin.settings.eveningWage.toString())
				.onChange(async (value) => {
					this.plugin.settings.eveningWage = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(wageSec)
			.setName('Night Wage (22:00 - Close)')
			.addText(text => text
				.setValue(this.plugin.settings.nightWage.toString())
				.onChange(async (value) => {
					this.plugin.settings.nightWage = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(wageSec)
			.setName('Sunday / Holiday Bonus (per hour)')
			.addText(text => text
				.setValue(this.plugin.settings.holidayBonus.toString())
				.onChange(async (value) => {
					this.plugin.settings.holidayBonus = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(wageSec)
			.setName('Daily Commuting Allowance')
			.setDesc('Added to your wage for each workday')
			.addText(text => text
				.setPlaceholder('e.g. 500')
				.setValue(this.plugin.settings.commutingAllowance.toString())
				.onChange(async (value) => {
					this.plugin.settings.commutingAllowance = Number(value);
					await this.plugin.saveSettings();
				}));

		wageSec.createEl('h3', {text: 'Store-specific Wage Bands'});
		wageSec.createEl('p', {
			text: 'Each store can override the default wage bands above. Aliases are used by AI parsing and store matching.',
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
			storeBox.createEl('h4', { text: store.name });

			new Setting(storeBox)
				.setName('Store Name')
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
				.setDesc('Comma-separated names or abbreviations that should map to this store.')
				.addTextArea(text => text
					.setValue(store.aliases.join(', '))
					.onChange(async (value) => {
						await updateStoreConfig(index, {
							aliases: value.split(',').map(alias => alias.trim()).filter(Boolean)
						});
					}));

			new Setting(storeBox)
				.setName('Short Label')
				.setDesc('Used on compact calendar shift chips.')
				.addText(text => text
					.setValue(store.shortName || store.name)
					.onChange(async (value) => {
						await updateStoreConfig(index, { shortName: value.trim() || store.name });
					}));

			(store.wageBands || []).forEach((band, bandIndex) => {
				const bandBox = storeBox.createDiv({ cls: 'jws-band-box' });
				bandBox.createEl('h5', { text: `Wage band from ${band.effectiveFrom}` });

				new Setting(bandBox)
					.setName('Effective From')
					.addText(text => {
						text.inputEl.type = 'date';
						text.setValue(band.effectiveFrom === '0000-01-01' ? '' : band.effectiveFrom)
							.onChange(async (value) => {
								await updateWageBand(index, bandIndex, { effectiveFrom: value || '0000-01-01' });
								this.display();
							});
					});

				[
					{ key: 'baseWage', label: 'Base Wage (09:00 - 17:00)' },
					{ key: 'morningWage', label: 'Morning Wage (Open - 09:00)' },
					{ key: 'eveningWage', label: 'Evening Wage (17:00 - 22:00)' },
					{ key: 'nightWage', label: 'Night Wage (22:00 - Close)' },
					{ key: 'holidayBonus', label: 'Sunday / Holiday Bonus' },
					{ key: 'commutingAllowance', label: 'Daily Commuting Allowance' }
				].forEach(({ key, label }) => {
					new Setting(bandBox)
						.setName(label)
						.addText(text => text
							.setValue(String((band as any)[key] ?? 0))
							.onChange(async (value) => {
								await updateWageBand(index, bandIndex, { [key]: Number(value) } as Partial<EffectiveWageBandConfig>);
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
				.setDesc('Use this when hourly wages change from a specific date.')
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
		legalSec.createEl('h3', {text: 'Calendar & Cycle Settings'});

		new Setting(legalSec)
			.setName('Payroll Cycle Starting Day')
			.setDesc('e.g., 21 for a 21st to 20th cycle. Use 1 for Natural Month.')
			.addText(text => text
				.setPlaceholder('21')
				.setValue((this.plugin.settings.payrollStartDay || 21).toString())
				.onChange(async (value) => {
					this.plugin.settings.payrollStartDay = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(legalSec)
			.setName('Custom Holidays')
			.setDesc('Enter dates (YYYY-MM-DD) separated by newlines to add custom rest days.')
			.addTextArea(text => text
				.setPlaceholder('2026-05-01\n2026-12-31')
				.setValue((this.plugin.settings.customHolidays || []).join('\n'))
				.onChange(async (value) => {
					this.plugin.settings.customHolidays = value.split('\n').map(d => d.trim()).filter(d => d.length > 0);
					await this.plugin.saveSettings();
				}));

		const holidayUpdatedText = this.plugin.settings.holidayCacheUpdatedAt
			? new Date(this.plugin.settings.holidayCacheUpdatedAt).toLocaleString()
			: 'Never';

		new Setting(legalSec)
			.setName('Japanese Holiday Cache')
			.setDesc(`Auto-fetched from holidays-jp.github.io. Last updated: ${holidayUpdatedText}`)
			.addButton(button => button
				.setButtonText('Refresh now')
				.onClick(async () => {
					await this.plugin.refreshHolidayCache(true);
					this.display();
				}));

		legalSec.createEl('h3', {text: 'Income Alerts'});
		legalSec.createEl('p', {
			text: 'Income thresholds for tax, social insurance and dependants change from year to year. Enter the amounts that apply to you this year. The plugin only reminds you; it does not work out tax.',
			cls: 'setting-item-description'
		});
		this.plugin.settings.incomeAlerts.forEach((alert, index) => {
			new Setting(legalSec)
				.setName(alert.label || `Alert ${index + 1}`)
				.setDesc(alert.period === 'annual' ? 'Income for the calendar year (Jan–Dec)' : 'Income for the current month')
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
			.setDesc('One period per line, e.g. 2026-08-01~2026-09-30. These days are checked against 8 hours each instead of the 28-hour week. Use the dates your school announces.')
			.addTextArea(text => text
				.setPlaceholder('2026-08-01~2026-09-30')
				.setValue((this.plugin.settings.vacationPeriods || []).join('\n'))
				.onChange(async (value) => {
					this.plugin.settings.vacationPeriods = value.split('\n').map(line => line.trim()).filter(Boolean);
					await this.plugin.saveSettings();
				}));

		legalSec.createEl('h3', {text: 'Legal & Overtime Settings'});

		new Setting(legalSec)
			.setName('Overtime Rate')
			.setDesc('Multiplier for work over 8h/day or 40h/week (Standard: 1.25)')
			.addText(text => text
				.setValue(this.plugin.settings.overtimeRate.toString())
				.onChange(async (value) => {
					this.plugin.settings.overtimeRate = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(legalSec)
			.setName('Paid Leave (有給休暇) Balance')
			.setDesc('Number of days available')
			.addText(text => text
				.setValue(this.plugin.settings.paidLeaveBalance.toString())
				.onChange(async (value) => {
					this.plugin.settings.paidLeaveBalance = Number(value);
					await this.plugin.saveSettings();
				}));
	}
}
