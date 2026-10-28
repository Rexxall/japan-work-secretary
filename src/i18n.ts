import { moment } from 'obsidian';

/** Obsidian sets moment's locale to its interface language, so this follows Settings → General → Language. */
export function isZh(): boolean {
	return moment.locale().toLowerCase().startsWith('zh');
}

/** The Chinese text when the interface is Chinese, otherwise the English. */
export function tr(en: string, zh: string): string {
	return isZh() ? zh : en;
}
