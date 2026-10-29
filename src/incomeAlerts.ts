import { tr } from './i18n';

export interface LegacyAlertSettings {
	incomeAlerts?: IncomeAlert[];
	taxWall88k?: boolean;
	taxWall103k?: boolean;
	taxWall130k?: boolean;
}

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

/** Alerts from saved settings; 1.1.x stored three on/off switches (taxWall88k, taxWall103k, taxWall130k) instead. */
export function migrateIncomeAlerts(settings: LegacyAlertSettings): IncomeAlert[] {
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
