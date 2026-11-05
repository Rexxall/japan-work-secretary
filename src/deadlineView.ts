import { BasesEntry, BasesPropertyId, BasesView, BasesViewRegistration, Keymap, Plugin, QueryController } from 'obsidian';
import { Bucket, Due, calendarDaysLeft, groupByBucket, parseDue, workingDaysLeft, ymd } from './deadlines';
import { HolidayUtility } from './holidayUtility';
import { rawValue } from './basesSupport';
import { tr } from './i18n';

export const DEADLINE_VIEW_ID = 'japan-work-deadlines';

interface Row {
	entry: BasesEntry;
	due: Due;
	done: boolean;
}

const BUCKET_TITLES: Record<Bucket, () => string> = {
	overdue: () => tr('Overdue', '已过期'),
	today: () => tr('Today', '今天'),
	thisWeek: () => tr('This week', '本周'),
	nextWeek: () => tr('Next week', '下周'),
	later: () => tr('Later', '之后')
};

const isHoliday = (date: string) => HolidayUtility.getHolidayName(date) !== null;

function isDone(raw: unknown): boolean {
	if (typeof raw === 'boolean') return raw;
	if (typeof raw === 'string') return ['true', 'yes', 'done', '済', '完了', '已完成'].includes(raw.trim().toLowerCase());
	return false;
}

/** The first visible property that most entries hold as a date, so the view works before anything is chosen. */
function guessDueProperty(plugin: Plugin, view: BasesView): BasesPropertyId | null {
	const entries = view.data.data.slice(0, 50);
	if (!entries.length) return null;
	for (const prop of view.config.getOrder()) {
		if (prop.startsWith('file.')) continue;
		if (entries.filter(entry => parseDue(rawValue(plugin, entry, prop))).length * 2 >= entries.length) return prop;
	}
	return null;
}

function formatDue(due: Due, now: Date): string {
	const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', weekday: 'short' };
	if (!due.allDay) Object.assign(options, { hour: '2-digit', minute: '2-digit' });
	if (due.date.getFullYear() !== now.getFullYear()) options.year = 'numeric';
	return due.date.toLocaleString(undefined, options);
}

/** The pill on the right: how much time is left, in working days where it matters. */
function leftLabel(row: Row, now: Date, countWorkingDays: boolean): { text: string; tone: string } {
	const days = calendarDaysLeft(row.due, now);
	if (row.done) return { text: tr('Done', '已完成'), tone: 'is-good' };
	if (days < 0 || (days === 0 && !row.due.allDay && row.due.date < now)) {
		const late = Math.max(-days, 0);
		return { text: late ? tr(`${late} d late`, `过了 ${late} 天`) : tr('Passed', '已过'), tone: 'is-bad' };
	}
	if (days === 0) {
		const time = row.due.allDay ? '' : row.due.date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
		return { text: time ? tr(`Due ${time}`, `${time} 截止`) : tr('Due today', '今天截止'), tone: 'is-bad' };
	}
	if (!countWorkingDays || days > 60) return { text: tr(`${days} d left`, `还有 ${days} 天`), tone: days <= 3 ? 'is-warn' : '' };
	const working = workingDaysLeft(row.due, now, isHoliday);
	if (working === 0) return { text: tr('Only days off left', '只剩休息日'), tone: 'is-warn' };
	return { text: tr(`${working} working ${working === 1 ? 'day' : 'days'}`, `还有 ${working} 个工作日`), tone: working <= 3 ? 'is-warn' : '' };
}

/** The deadline view for Bases: notes sorted into overdue, today, this week, next week and later. */
export function deadlineViewRegistration(plugin: Plugin): BasesViewRegistration {
	class DeadlineView extends BasesView {
		type = DEADLINE_VIEW_ID;
		private root: HTMLElement;

		constructor(controller: QueryController, parent: HTMLElement) {
			super(controller);
			this.root = parent.createDiv({ cls: 'japan-work-bases ap' });
			// "Today" and "overdue" move as the clock does.
			this.registerInterval(window.setInterval(() => this.render(), 5 * 60_000));
		}

		onDataUpdated(): void {
			this.render();
		}

		private render(): void {
			const now = new Date();
			const dueProp = this.config.getAsPropertyId('due') ?? guessDueProperty(plugin, this);
			const doneProp = this.config.getAsPropertyId('done');
			const showDone = this.config.get('showDone') === true;
			const countWorkingDays = this.config.get('workingDays') !== false;
			this.root.empty();

			const open: { item: Row; due: Due }[] = [];
			const finished: Row[] = [];
			let undated = 0;
			for (const entry of this.data.data) {
				const due = dueProp ? parseDue(rawValue(plugin, entry, dueProp)) : null;
				if (!due) { undated++; continue; }
				const row = { entry, due, done: doneProp ? isDone(rawValue(plugin, entry, doneProp)) : false };
				if (row.done) finished.push(row);
				else open.push({ item: row, due });
			}

			if (!open.length && !finished.length) {
				const empty = this.root.createDiv({ cls: 'ap-empty' });
				empty.createDiv({ cls: 'ap-empty-title', text: dueProp ? tr('No deadlines here', '这里没有截止日期') : tr('Choose the deadline property', '选出截止日期属性') });
				empty.createDiv({
					cls: 'ap-empty-text',
					text: dueProp
						? tr(`None of these notes has a date in “${this.config.getDisplayName(dueProp)}”.`, `这些笔记的“${this.config.getDisplayName(dueProp)}”里都没有日期。`)
						: tr('Open the view options and pick the property that holds each deadline.', '在视图选项里选出存截止日期的属性。')
				});
				return;
			}

			const groups = groupByBucket(open, now);
			const extra = this.config.getOrder().filter(prop => prop !== 'file.name' && prop !== dueProp && prop !== doneProp).slice(0, 1);
			for (const [bucket, rows] of groups) {
				if (rows.length) this.renderSection(BUCKET_TITLES[bucket](), rows, now, countWorkingDays, extra, bucket);
			}
			if (showDone && finished.length) this.renderSection(tr('Done', '已完成'), finished, now, countWorkingDays, extra, 'done');

			const notes: string[] = [];
			if (!showDone && finished.length) notes.push(tr(`${finished.length} done, hidden`, `${finished.length} 篇已完成，已隐藏`));
			if (undated) notes.push(tr(`${undated} without a date`, `${undated} 篇没有日期`));
			if (notes.length) this.root.createDiv({ cls: 'jws-bases-note', text: notes.join(' · ') });
		}

		private renderSection(title: string, rows: Row[], now: Date, countWorkingDays: boolean, extra: BasesPropertyId[], kind: string): void {
			const section = this.root.createDiv({ cls: `ap-section jws-bases-section is-${kind}` });
			const head = section.createDiv({ cls: 'ap-section-title' });
			head.createSpan({ text: title });
			head.createSpan({ cls: 'jws-bases-count', text: String(rows.length) });
			const list = section.createDiv({ cls: 'ap-group' });
			for (const row of rows) {
				const el = list.createEl('a', { cls: 'ap-row jws-bases-row', href: '#' });
				const main = el.createDiv({ cls: 'ap-row-main' });
				main.createDiv({ cls: 'ap-row-title', text: row.entry.file.basename });
				const desc = [formatDue(row.due, now)];
				const holiday = HolidayUtility.getHolidayName(ymd(row.due.date));
				if (holiday) desc.push(holiday);
				for (const prop of extra) {
					const text = row.entry.getValue(prop)?.toString() ?? '';
					if (text && text !== 'null') desc.push(text);
				}
				main.createDiv({ cls: 'ap-row-desc', text: desc.join(' · ') });
				const left = leftLabel(row, now, countWorkingDays);
				el.createSpan({ cls: `ap-pill ${left.tone}`.trim(), text: left.text });
				el.addEventListener('click', evt => {
					evt.preventDefault();
					void this.app.workspace.openLinkText(row.entry.file.path, '', Keymap.isModEvent(evt));
				});
			}
		}
	}

	return {
		name: tr('Deadlines', '截止日'),
		icon: 'calendar-clock',
		factory: (controller, containerEl) => new DeadlineView(controller, containerEl),
		options: () => [
			{ type: 'property', key: 'due', displayName: tr('Deadline', '截止日期'), placeholder: tr('A date property', '日期属性') },
			{ type: 'property', key: 'done', displayName: tr('Done when checked', '勾选即完成'), placeholder: tr('Optional, a checkbox property', '可不选，勾选框属性') },
			{ type: 'toggle', key: 'workingDays', displayName: tr('Count working days (skip weekends and Japanese holidays)', '按工作日计（跳过周末和日本节假日）'), default: true },
			{ type: 'toggle', key: 'showDone', displayName: tr('Show done', '显示已完成'), default: false }
		]
	};
}
