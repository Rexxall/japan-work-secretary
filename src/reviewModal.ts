import { App, Modal } from 'obsidian';
import type JapanWorkSecretaryPlugin from './main';
import { ParsedShiftDraft } from './aiParser';
import { Shift, normalizeStoreConfigs } from './data';
import { HoursTracker, parseVacationPeriods } from './hoursTracker';
import { WageCalculator } from './wageCalculator';
import { breakMissingText } from './ruleNotes';

interface ReviewRow extends ParsedShiftDraft {
    keep: boolean;
}

/** Same date, times and store as a shift that is already saved. */
export function isDuplicateShift(existing: Shift[], draft: ParsedShiftDraft): boolean {
    return existing.some(s => s.date === draft.date && s.startTime === draft.startTime && s.endTime === draft.endTime && s.storeName === draft.storeName);
}

/**
 * Shows what the AI read before anything is saved. Each row can be corrected or
 * left out; duplicates start unticked, and rows that would break the 28-hour or
 * vacation 8-hour rule are marked.
 */
export class ShiftReviewModal extends Modal {
    private rows: ReviewRow[];
    private saved = false;

    constructor(app: App, private plugin: JapanWorkSecretaryPlugin, drafts: ParsedShiftDraft[], private source: string, private onConfirm: (drafts: ParsedShiftDraft[]) => Promise<void>) {
        super(app);
        this.rows = drafts.map(draft => ({ ...draft, keep: !isDuplicateShift(plugin.shiftData.shifts, draft) }));
    }

    onOpen() {
        this.modalEl.addClass('jws-modal', 'jws-review-modal');
        this.modalEl.addClass('ap', 'ap-modal');
        this.setTitle('Check shifts before saving');
        this.render();
    }

    private render() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createDiv({ cls: 'ap-modal-kicker', text: `Read from ${this.source}. Fix anything the AI got wrong, then save.` });

        const calculator = new WageCalculator(this.plugin.settings);
        const tracker = new HoursTracker(parseVacationPeriods(this.plugin.settings.vacationPeriods));
        const stores = normalizeStoreConfigs(this.plugin.settings.storeConfigs).map(store => store.name);
        const kept = this.rows.filter(row => row.keep);
        const withKept: Shift[] = [
            ...this.plugin.shiftData.shifts,
            ...kept.map((row, i) => {
                const wage = calculator.calculateShiftWage(row.date, row.startTime, row.endTime, false, undefined, row.storeName);
                return { id: `draft-${i}`, ...row, calculatedHours: wage.totalHours, calculatedWage: wage.wageAmount };
            })
        ];
        const vacationOver = new Set(tracker.findVacationDaysOverLimit(withKept).map(day => day.date));

        const list = contentEl.createDiv({ cls: 'jws-review-list' });
        this.rows.forEach(row => {
            const item = list.createDiv({ cls: `jws-review-row${row.keep ? '' : ' is-off'}` });
            const check = item.createEl('input', { attr: { type: 'checkbox', 'aria-label': 'Save this shift' } });
            check.checked = row.keep;
            check.onchange = () => { row.keep = check.checked; this.render(); };

            const fields = item.createDiv({ cls: 'jws-review-fields' });
            const date = fields.createEl('input', { attr: { type: 'date', value: row.date, 'aria-label': 'Date' } });
            const start = fields.createEl('input', { attr: { type: 'time', value: row.startTime, 'aria-label': 'Start' } });
            const end = fields.createEl('input', { attr: { type: 'time', value: row.endTime, 'aria-label': 'End' } });
            const store = fields.createEl('select', { attr: { 'aria-label': 'Store' } });
            const options = stores.includes(row.storeName) ? stores : [row.storeName, ...stores];
            options.forEach(name => {
                const option = store.createEl('option', { text: name });
                option.value = name;
                option.selected = name === row.storeName;
            });
            const commit = () => {
                row.date = date.value || row.date;
                row.startTime = start.value || row.startTime;
                row.endTime = end.value || row.endTime;
                row.storeName = store.value;
                this.render();
            };
            [date, start, end, store].forEach(input => { input.onchange = commit; });

            const info = item.createDiv({ cls: 'jws-review-info' });
            const wage = calculator.calculateShiftWage(row.date, row.startTime, row.endTime, false, undefined, row.storeName);
            info.createSpan({ cls: 'ap-num', text: `${wage.totalHours.toFixed(2)} h · ¥${Math.round(wage.wageAmount).toLocaleString()}` });
            if (wage.breakMissing) info.createSpan({ cls: 'ap-pill is-warn', text: 'No break entered', attr: { title: breakMissingText(wage.requiredBreakMinutes) } });
            if (isDuplicateShift(this.plugin.shiftData.shifts, row)) info.createSpan({ cls: 'ap-pill', text: 'Already saved' });
            if (row.keep) {
                if (vacationOver.has(row.date)) info.createSpan({ cls: 'ap-pill is-danger', text: 'Over 8 h that day' });
                const peak = tracker.checkPeak7DayWindow(withKept, row.date);
                if (peak.isOverLimit) {
                    info.createSpan({ cls: 'ap-pill is-danger', text: `${peak.totalHoursLast7Days} h in 7 days${peak.mixesVacation ? ' (term and vacation)' : ''}` });
                }
            }
        });

        if (this.rows.length === 0) list.createDiv({ cls: 'ap-muted', text: 'No shifts were found.' });

        const foot = contentEl.createDiv({ cls: 'ap-modal-foot' });
        foot.createDiv({ cls: 'ap-foot-note', text: 'Pay is an estimate before overtime. Breaks are not deducted until you enter them.' });
        const cancel = foot.createEl('button', { text: 'Cancel' });
        cancel.onclick = () => this.close();
        const save = foot.createEl('button', { text: kept.length === 1 ? 'Save 1 shift' : `Save ${kept.length} shifts`, cls: 'mod-cta' });
        save.disabled = kept.length === 0 || this.saved;
        save.onclick = async () => {
            this.saved = true;
            save.disabled = true;
            this.close();
            await this.onConfirm(kept.map(({ keep: _keep, ...draft }) => draft));
        };
    }

    onClose() { this.contentEl.empty(); }
}
