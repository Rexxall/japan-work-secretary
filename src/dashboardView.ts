import { ItemView, WorkspaceLeaf, Notice, Menu, requestUrl, Modal, App, setIcon, moment } from 'obsidian';
import { tr } from './i18n';
import JapanWorkSecretaryPlugin, { errorMessage } from './main';
import { HoursTracker, parseVacationPeriods } from './hoursTracker';
import { WageCalculator } from './wageCalculator';
import { HolidayUtility } from './holidayUtility';
import { ExchangeRateSnapshot, Shift, ShiftTemplatePattern, buildRecurringInstanceId, getStoreColorClass, getStoreShortName, getStoreWageBand, normalizeStoreConfigs, parseRecurringInstanceId } from './data';
import { PolicyExplanationModal } from './policyModal';
import { appendMixedWeekNote, breakMissingText } from './ruleNotes';

type Moment = ReturnType<typeof moment>;

export const DASHBOARD_VIEW_TYPE = 'japan-work-dashboard-view';

interface RmbExchangeRateDisplay {
    rate: number;
    title: string;
}

export class DashboardView extends ItemView {
	plugin: JapanWorkSecretaryPlugin;
    viewMode: 'month' | 'week' = 'month';
    currentViewDate: Moment = moment();
    selectedDate: Moment = moment();
    editingRecurringId: string | null = null;
    
    // Weekly Pattern State
    weeklyPattern: { active: boolean, start: string, end: string }[] = Array(7).fill(0).map(() => ({ active: false, start: '17:00', end: '22:00' }));
    batchStartDate: string = '';
    batchEndDate: string = '';
    templateName: string = 'Regular weekly pattern';
    weeklyPatternStoreName: string = '';
    
    private isPayrollView: boolean = false; // Toggle between Natural Month and 21st-20th cycle
    exchangeRate: number = 0.0432; // Default fallback
    private annualWage: number = 0;
    lastExchangeUpdate: number = 0;
    private pendingExchangeRateDates: Set<string> = new Set();
    private activeDashboardTab: 'calendar' | 'management' = 'calendar';


	constructor(leaf: WorkspaceLeaf, plugin: JapanWorkSecretaryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return DASHBOARD_VIEW_TYPE;
	}

	getDisplayText() {
		return tr('Work dashboard', '打工面板');
	}

	async onOpen() {
		this.render();
        await this.fetchExchangeRate();
	}

    async fetchExchangeRate() {
        // Only update once every hour
        if (Date.now() - this.lastExchangeUpdate < 3600000) return;

        try {
            const liveSnapshot = await this.fetchLiveExchangeRateSnapshot();
            if (liveSnapshot) {
                this.exchangeRate = liveSnapshot.rate;
                this.lastExchangeUpdate = Date.now();
                this.render(); // Re-render with new rate
            }
        } catch (e) {
            console.error("Failed to fetch exchange rate", e);
        }
    }

    private async fetchLiveExchangeRateSnapshot(): Promise<ExchangeRateSnapshot | null> {
        try {
            const frankfurterSnapshot = await this.fetchFrankfurterExchangeRate();
            if (frankfurterSnapshot) return frankfurterSnapshot;
        } catch (error) {
            console.warn('Failed to fetch live rate from Frankfurter; falling back to ExchangeRate-API.', error);
        }

        const response = await requestUrl({
            url: 'https://api.exchangerate-api.com/v4/latest/JPY'
        });
        const rate = Number((response.json as { rates?: { CNY?: unknown } } | null)?.rates?.CNY);
        if (!Number.isFinite(rate) || rate <= 0) return null;

        return {
            date: moment().format('YYYY-MM-DD'),
            rate,
            provider: 'ExchangeRate-API',
            providerDate: moment().format('YYYY-MM-DD'),
            fetchedAt: new Date().toISOString()
        };
    }

    private async fetchFrankfurterExchangeRate(date?: string): Promise<ExchangeRateSnapshot | null> {
        const query = date ? `?date=${date}` : '';
        const response = await requestUrl({
            url: `https://api.frankfurter.dev/v2/rate/JPY/CNY${query}`
        });
        const body = response.json as { rate?: unknown; date?: unknown } | null;
        const rate = Number(body?.rate);
        if (!Number.isFinite(rate) || rate <= 0) return null;

        return {
            date: date || moment().format('YYYY-MM-DD'),
            rate,
            provider: 'Frankfurter',
            providerDate: typeof body?.date === 'string' ? body.date : date,
            fetchedAt: new Date().toISOString()
        };
    }

    private getPayrollPayDate(periodEnd: Moment): Moment {
        return periodEnd.clone().add(1, 'month').date(5).startOf('day');
    }

    private getRmbExchangeRateForPeriod(periodEnd: Moment): RmbExchangeRateDisplay {
        const payDate = this.getPayrollPayDate(periodEnd);
        const payDateKey = payDate.format('YYYY-MM-DD');
        const today = moment().startOf('day');

        if (payDate.isAfter(today)) {
            return {
                rate: this.exchangeRate,
                title: `Live estimate until payday ${payDateKey}: 1 JPY = ${this.exchangeRate} CNY`
            };
        }

        const cached = this.plugin.shiftData.exchangeRates?.[payDateKey];
        if (cached && Number.isFinite(Number(cached.rate)) && Number(cached.rate) > 0) {
            const providerDate = cached.providerDate && cached.providerDate !== payDateKey
                ? `, provider date ${cached.providerDate}`
                : '';
            return {
                rate: Number(cached.rate),
                title: `Fixed payday rate ${payDateKey}${providerDate}: 1 JPY = ${cached.rate} CNY (${cached.provider})`
            };
        }

        this.ensurePaydayExchangeRate(payDateKey);
        return {
            rate: this.exchangeRate,
            title: `Temporary live rate while fetching payday rate ${payDateKey}: 1 JPY = ${this.exchangeRate} CNY`
        };
    }

    private ensurePaydayExchangeRate(payDateKey: string) {
        if (this.pendingExchangeRateDates.has(payDateKey)) return;
        this.pendingExchangeRateDates.add(payDateKey);

        this.fetchFrankfurterExchangeRate(payDateKey)
            .then(async snapshot => {
                if (!snapshot) return;
                this.plugin.shiftData.exchangeRates = this.plugin.shiftData.exchangeRates || {};
                this.plugin.shiftData.exchangeRates[payDateKey] = snapshot;
                await this.plugin.saveDataStore();
                this.render();
            })
            .catch(error => {
                console.error(`Failed to fetch exchange rate for payday ${payDateKey}`, error);
            })
            .finally(() => {
                this.pendingExchangeRateDates.delete(payDateKey);
            });
    }

    private getStoreOptions() {
        return normalizeStoreConfigs(this.plugin.settings.storeConfigs);
    }

    private populateStoreSelect(selectEl: HTMLSelectElement, selectedStore?: string) {
        this.getStoreOptions().forEach(store => {
            const opt = selectEl.createEl('option', { text: store.name });
            opt.value = store.name;
            if (selectedStore && store.name === selectedStore) opt.selected = true;
        });
    }

    private getPeriodForDate(date: Moment): { start: Moment, end: Moment, label: string } {
        if (this.isPayrollView) {
            const cutoffDay = this.plugin.settings.payrollStartDay || 21;
            const pStart = date.date() >= cutoffDay
                ? date.clone().date(cutoffDay)
                : date.clone().subtract(1, 'month').date(cutoffDay);
            const pEnd = pStart.clone().add(1, 'month').date(cutoffDay - 1);
            return {
                start: pStart,
                end: pEnd,
                label: `${pStart.format('MM/DD')} - ${pEnd.format('MM/DD')}`
            };
        }

        return {
            start: date.clone().startOf('month'),
            end: date.clone().endOf('month'),
            label: date.format('MMMM YYYY')
        };
    }

    private getVisibleSyncPeriod(): { start: Moment, end: Moment, label: string } {
        if (this.viewMode === 'week') {
            const start = this.currentViewDate.clone().startOf('isoWeek');
            const end = this.currentViewDate.clone().endOf('isoWeek');
            return {
                start,
                end,
                label: `${start.format('MM/DD')} - ${end.format('MM/DD')}`
            };
        }

        return this.getPeriodForDate(this.currentViewDate);
    }

    private getPreviousPeriod(start: Moment, end: Moment): { start: Moment, end: Moment } {
        if (this.isPayrollView) {
            return {
                start: start.clone().subtract(1, 'month'),
                end: end.clone().subtract(1, 'month')
            };
        }

        return {
            start: start.clone().subtract(1, 'month').startOf('month'),
            end: start.clone().subtract(1, 'month').endOf('month')
        };
    }

    private getWorkMonthPeriod(date: Moment): { start: Moment, end: Moment, label: string } {
        const cutoffDay = this.plugin.settings.payrollStartDay || 21;
        const start = date.date() >= cutoffDay
            ? date.clone().date(cutoffDay)
            : date.clone().subtract(1, 'month').date(cutoffDay);
        const end = start.clone().add(1, 'month').date(cutoffDay - 1);
        return {
            start,
            end,
            label: `${start.format('MM/DD')} - ${end.format('MM/DD')}`
        };
    }

    private getNextWorkMonthPeriod(date: Moment): { start: Moment, end: Moment, label: string } {
        const current = this.getWorkMonthPeriod(date);
        const start = current.start.clone().add(1, 'month');
        const end = current.end.clone().add(1, 'month');
        return {
            start,
            end,
            label: `${start.format('MM/DD')} - ${end.format('MM/DD')}`
        };
    }

    private getActiveTemplatePatterns(storeName: string): ShiftTemplatePattern[] {
        return this.weeklyPattern
            .map((pattern, dayOfWeek) => ({
                dayOfWeek,
                startTime: pattern.start,
                endTime: pattern.end,
                storeName
            }))
            .filter((pattern, dayOfWeek) => this.weeklyPattern[dayOfWeek].active);
    }

    private async createRecurringRulesFromPatterns(patterns: ShiftTemplatePattern[], startDate?: string, endDate?: string): Promise<number> {
        if (!this.plugin.ensureScheduleMutationAllowed()) return -1;
        let added = 0;

        for (const pattern of patterns) {
            const duplicate = this.plugin.shiftData.recurringShifts.some(rs =>
                rs.dayOfWeek === pattern.dayOfWeek &&
                rs.startTime === pattern.startTime &&
                rs.endTime === pattern.endTime &&
                rs.storeName === pattern.storeName &&
                this.recurringRangesOverlap(rs.startDate, rs.endDate, startDate, endDate)
            );

            if (duplicate) continue;

            this.plugin.shiftData.recurringShifts.push({
                id: crypto.randomUUID(),
                dayOfWeek: pattern.dayOfWeek,
                startTime: pattern.startTime,
                endTime: pattern.endTime,
                storeName: pattern.storeName,
                startDate: startDate || undefined,
                endDate: endDate || undefined
            });
            added++;
        }

        if (added > 0) {
            await this.plugin.saveDataStore();
        }

        return added;
    }

    private recurringRangesOverlap(existingStart?: string, existingEnd?: string, newStart?: string, newEnd?: string): boolean {
        const minDate = '0000-01-01';
        const maxDate = '9999-12-31';
        const aStart = existingStart || minDate;
        const aEnd = existingEnd || maxDate;
        const bStart = newStart || minDate;
        const bEnd = newEnd || maxDate;
        return aStart <= bEnd && bStart <= aEnd;
    }

    private async applyTemplateToWorkMonth(patterns: ShiftTemplatePattern[], period: { start: Moment, end: Moment }): Promise<number> {
        const start = period.start.format('YYYY-MM-DD');
        const end = period.end.format('YYYY-MM-DD');
        return this.createRecurringRulesFromPatterns(patterns, start, end);
    }

    private async saveTemplateFromRange(start: Moment, end: Moment, name: string): Promise<number> {
        const shifts = this.getShiftsInRange(start, end);
        const patternMap = new Map<string, ShiftTemplatePattern>();

        shifts.forEach(shift => {
            const dayOfWeek = moment(shift.date).day();
            const pattern = {
                dayOfWeek,
                startTime: shift.startTime,
                endTime: shift.endTime,
                storeName: shift.storeName
            };
            patternMap.set(`${dayOfWeek}|${pattern.startTime}|${pattern.endTime}|${pattern.storeName}`, pattern);
        });

        const patterns = Array.from(patternMap.values())
            .sort((a, b) => `${a.dayOfWeek}${a.startTime}`.localeCompare(`${b.dayOfWeek}${b.startTime}`));
        if (patterns.length === 0) return 0;

        this.plugin.shiftData.shiftTemplates = this.plugin.shiftData.shiftTemplates || [];
        const now = moment().toISOString();
        const existing = this.plugin.shiftData.shiftTemplates.find(t => t.name === name);
        if (existing) {
            existing.patterns = patterns;
            existing.updatedAt = now;
        } else {
            this.plugin.shiftData.shiftTemplates.push({
                id: crypto.randomUUID(),
                name,
                patterns,
                createdAt: now,
                updatedAt: now
            });
        }

        await this.plugin.saveDataStore();
        return patterns.length;
    }

    private loadTemplateIntoEditor(patterns: ShiftTemplatePattern[]) {
        this.weeklyPattern = Array(7).fill(0).map(() => ({ active: false, start: '17:00', end: '22:00' }));
        patterns.forEach(pattern => {
            if (pattern.dayOfWeek < 0 || pattern.dayOfWeek > 6) return;
            this.weeklyPattern[pattern.dayOfWeek] = {
                active: true,
                start: pattern.startTime,
                end: pattern.endTime
            };
        });
        this.weeklyPatternStoreName = patterns[0]?.storeName || this.weeklyPatternStoreName;
    }

    /**
     * Helper to get all shifts (one-off + recurring expanded) for a specific range
     */
    getShiftsInRange(start: Moment, end: Moment) {
        const calculator = new WageCalculator(this.plugin.settings);
        
        // Manual shifts
        const shifts = this.plugin.shiftData.shifts.filter(s => {
            const m = moment(s.date);
            return m.isSameOrAfter(start, 'day') && m.isSameOrBefore(end, 'day');
        }).map(s => {
            // Re-calculate to match newest logic/settings
            const res = calculator.calculateShiftWage(s.date, s.startTime, s.endTime, s.isPaidLeave, s.breakMinutes, s.storeName);
            return {
                ...s,
                calculatedHours: res.totalHours,
                calculatedWage: res.wageAmount
            };
        });

        // Expand recurring shifts
        const curr = start.clone();
        while (curr.isSameOrBefore(end, 'day')) {
            const dow = curr.day(); // 0-6
            const recurrences = this.plugin.shiftData.recurringShifts.filter(rs => rs.dayOfWeek === dow);
            
            for (const rs of recurrences) {
                const dateStr = curr.format('YYYY-MM-DD');
                if (rs.startDate && curr.isBefore(moment(rs.startDate), 'day')) continue;
                if (rs.endDate && curr.isAfter(moment(rs.endDate), 'day')) continue;
                if (rs.exceptions && rs.exceptions.includes(dateStr)) continue;

                const exists = shifts.some(s =>
                    s.date === dateStr &&
                    s.startTime === rs.startTime &&
                    s.endTime === rs.endTime &&
                    s.storeName === rs.storeName
                );
                if (!exists) {
                    const res = calculator.calculateShiftWage(dateStr, rs.startTime, rs.endTime, false, undefined, rs.storeName);
                    shifts.push({
                        id: buildRecurringInstanceId(rs.id, dateStr),
                        date: dateStr,
                        startTime: rs.startTime,
                        endTime: rs.endTime,
                        storeName: rs.storeName,
                        calculatedHours: res.totalHours,
                        calculatedWage: res.wageAmount
                    });
                }
            }
            curr.add(1, 'day');
        }

        return shifts
            .map(shift => ({
                ...shift,
                isSynced: this.plugin.isShiftCalendarSynced(shift)
            }))
            .sort((a,b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
    }

	render() {
		this.contentEl.empty();
		this.contentEl.addClass('jws-view-content');
		const rootEl = this.contentEl.createDiv({ cls: 'japan-work-dashboard ap ap-view' });

        const activePeriod = this.getPeriodForDate(this.currentViewDate);
        const calcStart = activePeriod.start;
        const calcEnd = activePeriod.end;
        const monthlyWage = this.getMonthlyWage(calcStart, calcEnd);

        // --- Header: what am I looking at, then the controls ---
        const head = rootEl.createDiv({ cls: 'ap-head ap-bar-glass jws-head' });
        const headMain = head.createDiv({ cls: 'ap-head-main' });
        headMain.createDiv({ cls: 'ap-eyebrow', text: 'Japan Work Secretary' });
        headMain.createEl('h2', {
            cls: 'ap-title',
            text: this.viewMode === 'month'
                ? this.currentViewDate.format(tr('MMMM YYYY', 'YYYY年M月'))
                : tr(`Week of ${this.currentViewDate.clone().startOf('isoWeek').format('MMM D')}`, `${this.currentViewDate.clone().startOf('isoWeek').format('M月D日')}起的一周`)
        });
        headMain.createDiv({
            cls: 'ap-sub',
            text: this.isPayrollView ? tr(`Work month ${activePeriod.label}`, `工资月 ${activePeriod.label}`) : tr('Calendar month', '自然月')
        });

        const actions = head.createDiv({ cls: 'ap-head-actions' });
        const prevBtn = actions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': tr('Previous', '上一页') } });
        setIcon(prevBtn, 'chevron-left');
        const todayBtn = actions.createEl('button', { text: tr('Today', '今天') });
        const nextBtn = actions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': tr('Next', '下一页') } });
        setIcon(nextBtn, 'chevron-right');
        prevBtn.onClickEvent(() => {
            this.currentViewDate.subtract(1, this.viewMode === 'month' ? 'month' : 'week');
            this.render();
        });
        nextBtn.onClickEvent(() => {
            this.currentViewDate.add(1, this.viewMode === 'month' ? 'month' : 'week');
            this.render();
        });
        todayBtn.onClickEvent(() => {
            this.currentViewDate = moment();
            this.selectedDate = moment();
            this.render();
        });
        const shareBtn = actions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': tr('Share or export', '分享或导出') } });
        setIcon(shareBtn, 'share');
        shareBtn.onClickEvent(() => {
            const period = this.getPeriodForDate(this.currentViewDate);
            new ShiftShareModal(
                this.app,
                period.start,
                period.end,
                (start, end) => this.getShiftsInRange(start, end),
                (shifts) => this.calculateTotalSum(shifts),
                this.plugin
            ).open();
        });
        // Pay period and calendar sync are set once and rarely changed, so they live in this menu.
        const moreBtn = actions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': tr('Pay period and calendar sync', '工资口径与日历同步') } });
        setIcon(moreBtn, 'more-horizontal');
        moreBtn.onClickEvent(event => this.openMoreMenu(event));
        const addBtn = actions.createEl('button', { text: tr('Add shift', '加班次'), cls: 'mod-cta' });
        addBtn.onClickEvent(() => {
            new QuickAddShiftModal(this.app, this.selectedDate.format('YYYY-MM-DD'), this.plugin, () => this.render(), (a, b) => this.getShiftsInRange(a, b)).open();
        });

        const toolbar = rootEl.createDiv({ cls: 'jws-toolbar' });
        this.segmented(toolbar, [
            { label: tr('Overview', '总览'), active: this.activeDashboardTab === 'calendar', onClick: () => { this.activeDashboardTab = 'calendar'; } },
            { label: tr('Manage', '管理'), active: this.activeDashboardTab === 'management', onClick: () => { this.activeDashboardTab = 'management'; } }
        ]);
        if (this.plugin.isCalendarSyncRunning()) toolbar.createSpan({ cls: 'ap-pill is-accent', text: tr('Syncing calendar…', '日历同步中…') });

        const contentWrapper = rootEl.createDiv({ cls: 'jws-body' });
        this.renderStartOrSamples(contentWrapper);

        if (this.activeDashboardTab === 'calendar') {
            const currentShifts = this.getShiftsInRange(calcStart, calcEnd);
            const monthTotalHours = Math.round(currentShifts.reduce((sum, s) => sum + (s.calculatedHours || 0), 0) * 10) / 10;

            const stats = contentWrapper.createDiv({ cls: 'jws-stats' });

            // Hours and pay for the period, side by side in one card.
            const summary = stats.createDiv({ cls: 'ap-card jws-summary' });
            summary.createDiv({ cls: 'ap-label', text: this.isPayrollView ? tr('This work month', '本工资月') : tr('This month', '本月') });
            const figures = summary.createDiv({ cls: 'ap-stats jws-summary-stats' });
            const hoursStat = figures.createDiv({ cls: 'ap-stat' });
            hoursStat.createDiv({ cls: 'ap-stat-label', text: tr('Hours', '工时') });
            const hoursValue = hoursStat.createDiv();
            hoursValue.createSpan({ cls: 'ap-stat-value', text: String(monthTotalHours) });
            hoursValue.createSpan({ cls: 'ap-stat-unit', text: 'h' });
            hoursStat.createDiv({ cls: 'ap-cap', text: tr(`${currentShifts.length} shift${currentShifts.length === 1 ? '' : 's'}`, `${currentShifts.length} 个班次`) });
            const wageStat = figures.createDiv({ cls: 'ap-stat' });
            wageStat.createDiv({ cls: 'ap-stat-label', text: tr('Estimated wage', '预计工资') });
            wageStat.createDiv({ cls: 'ap-stat-value', text: `¥${monthlyWage.toLocaleString()}` });
            const rmbRate = this.getRmbExchangeRateForPeriod(calcEnd);
            wageStat.createDiv({
                cls: 'ap-cap',
                text: `≈ ¥${Math.floor(monthlyWage * rmbRate.rate).toLocaleString()} RMB`,
                attr: { title: rmbRate.title }
            });

            const peak = this.renderPeakCard(stats);
            this.renderIncomeAnalyticsCard(stats, calcStart, calcEnd, activePeriod.label, monthlyWage, currentShifts);

            const calendarSection = contentWrapper.createDiv({ cls: 'jws-calendar-section' });
            const calendarHead = calendarSection.createDiv({ cls: 'jws-cal-head' });
            calendarHead.createDiv({ cls: 'ap-label', text: tr('Shifts', '排班') });
            this.segmented(calendarHead, [
                { label: tr('Month', '月'), active: this.viewMode === 'month', onClick: () => { this.viewMode = 'month'; } },
                { label: tr('Week', '周'), active: this.viewMode === 'week', onClick: () => { this.viewMode = 'week'; } }
            ]);
            if (this.viewMode === 'month') {
                this.renderCalendar(calendarSection, peak);
            } else {
                this.renderWeekView(calendarSection);
            }

            const chartCard = contentWrapper.createDiv({ cls: 'ap-card jws-week-chart' });
            this.renderWeeklyChart(chartCard);
        } else {
            const summaryGrid = contentWrapper.createDiv({ cls: 'jws-grid' });
            const yearStart = this.currentViewDate.clone().startOf('year');
            const yearEnd = this.currentViewDate.clone().endOf('year');
            this.annualWage = this.getAnnualWage(yearStart, yearEnd);
            this.renderTaxStrategyCard(summaryGrid, monthlyWage, this.annualWage);
            this.renderLegalStatusCard(summaryGrid);

            contentWrapper.createDiv({ cls: 'ap-label jws-section-label', text: tr('Shift management', '班次管理') });
            const mgmtGrid = contentWrapper.createDiv({ cls: 'jws-grid' });
            const formCard = mgmtGrid.createDiv({ cls: 'ap-card' });
            this.renderLeftManagementColumn(formCard);
            const recurCard = mgmtGrid.createDiv({ cls: 'ap-card' });
            recurCard.createDiv({ cls: 'ap-label', text: tr('Weekly pattern · batch add', '每周固定班 · 批量添加') });
            this.renderRightManagementColumn(recurCard);
        }
	}

    /** Pay period (calendar month or payroll cycle) and the three calendar sync modes. */
    private openMoreMenu(event: MouseEvent) {
        const menu = new Menu();
        const startDay = this.plugin.settings.payrollStartDay || 21;
        menu.addItem(item => item.setTitle(tr('Count by calendar month', '按自然月统计')).setChecked(!this.isPayrollView)
            .onClick(() => { this.isPayrollView = false; this.render(); }));
        menu.addItem(item => item.setTitle(tr(`Count by work month (from day ${startDay})`, `按工资月统计（每月 ${startDay} 日起）`)).setChecked(this.isPayrollView)
            .onClick(() => { this.isPayrollView = true; this.render(); }));
        menu.addSeparator();
        const runSync = (action: () => Promise<unknown>) => {
            if (this.plugin.isCalendarSyncRunning()) {
                new Notice(tr('Calendar sync is already running.', '日历正在同步。'));
                return;
            }
            const done = action();
            this.render();
            void done.finally(() => this.render());
        };
        const busy = this.plugin.isCalendarSyncRunning();
        menu.addItem(item => item.setTitle(tr('Sync new and changed shifts', '同步新增和改动的班次')).setIcon('refresh-cw').setDisabled(busy)
            .onClick(() => runSync(() => this.plugin.smartSyncCalendar())));
        menu.addItem(item => item.setTitle(tr('Sync the period shown', '同步当前显示的这段')).setIcon('calendar-range').setDisabled(busy)
            .onClick(() => runSync(() => {
                const period = this.getVisibleSyncPeriod();
                return this.plugin.syncCalendarRange(period.start.format('YYYY-MM-DD'), period.end.format('YYYY-MM-DD'), period.label);
            })));
        menu.addItem(item => item.setTitle(tr('Rewrite all shifts in the calendar', '在日历里重写全部班次')).setIcon('calendar-sync').setDisabled(busy)
            .onClick(() => runSync(() => this.plugin.syncAllShifts())));
        menu.showAtMouseEvent(event);
    }

    private segmented(parent: HTMLElement, options: { label: string, active: boolean, title?: string, onClick: () => void }[]) {
        const seg = parent.createDiv({ cls: 'ap-seg' });
        options.forEach(option => {
            const button = seg.createEl('button', {
                text: option.label,
                cls: option.active ? 'is-active' : '',
                attr: { 'aria-pressed': String(option.active), ...(option.title ? { title: option.title } : {}) }
            });
            button.onClickEvent(() => {
                option.onClick();
                this.render();
            });
        });
    }

    /**
     * The 28-hour rule is about any rolling 7 days, so the card shows the busiest window
     * around the selected date, how full it is, and the hours of each day in it.
     */
    /** An empty dashboard offers a sample week; while samples are shown, a way to remove them. */
    private renderStartOrSamples(parent: HTMLElement) {
        const shifts = this.plugin.shiftData.shifts;
        const samples = shifts.filter(shift => shift.isSample).length;
        if (samples > 0) {
            const box = parent.createDiv({ cls: 'ap-notice jws-sample-banner' });
            box.createSpan({ cls: 'ap-grow', text: tr(`${samples} sample shifts at "Sample store" this week. They are never synced or exported.`, `本周有 ${samples} 个“示例店”的示例班次，不会同步到日历，也不会导出。`) });
            box.createEl('button', { text: tr('Remove samples', '删除示例') }).onclick = () => void this.plugin.removeSamples();
            return;
        }
        if (shifts.length > 0 || this.plugin.shiftData.recurringShifts.length > 0) return;
        const card = parent.createDiv({ cls: 'ap-card jws-start' });
        card.createEl('h3', { cls: 'ap-title', text: tr('No shifts yet', '还没有班次') });
        card.createDiv({ cls: 'ap-sub', text: tr('Load a made-up week to see hours, estimated pay and the 28-hour check. Remove it in one click. To add your own, use "Add shift" above.', '先载入一周示例，看看工时、预计工资和 28 小时检查。一键就能删。记自己的班次点上方“加班次”。') });
        card.createEl('button', { text: tr('Load a sample week', '载入示例一周'), cls: 'mod-cta' }).onclick = () => void this.plugin.loadSampleWeek();
    }

    private renderPeakCard(parent: HTMLElement): { start: string, end: string, hours: number, isOverLimit: boolean } {
        const tracker = new HoursTracker(parseVacationPeriods(this.plugin.settings.vacationPeriods || []));
        const selected = this.selectedDate.format('YYYY-MM-DD');
        const shiftsForCheck = this.getShiftsInRange(this.selectedDate.clone().subtract(6, 'days'), this.selectedDate.clone().add(6, 'days'));
        const result = tracker.checkPeak7DayWindow(shiftsForCheck, selected);
        const ratio = result.totalHoursLast7Days / 28;
        const tone = result.isOverLimit ? 'is-danger' : ratio >= 0.85 ? 'is-warn' : 'is-good';

        const card = parent.createDiv({ cls: `ap-card jws-peak-card ${result.isOverLimit ? 'is-danger' : ratio >= 0.85 ? 'is-warn' : ''}`.trim() });
        card.createDiv({ cls: 'ap-label', text: tr(`Peak 7 days · around ${this.selectedDate.format('M/D')}`, `最忙的 7 天 · ${this.selectedDate.format('M/D')} 前后`) });
        const value = card.createDiv();
        value.createSpan({ cls: 'ap-stat-value', text: String(result.totalHoursLast7Days) });
        value.createSpan({ cls: 'ap-stat-unit', text: '/ 28 h' });
        const meter = card.createDiv({ cls: `ap-meter ${tone}` });
        meter.createDiv({ cls: 'ap-meter-fill' }).setCssProps({ '--ap-value': `${Math.min(ratio, 1) * 100}%` });
        const split = card.createDiv({ cls: 'ap-split' });
        split.createSpan({ text: `${moment(result.peakWindowStart).format('M/D ddd')} – ${moment(result.peakWindowEnd).format('M/D ddd')}` });
        split.createSpan({
            text: result.isOverLimit
                ? tr(`over by ${Math.round((result.totalHoursLast7Days - 28) * 100) / 100} h`, `超出 ${Math.round((result.totalHoursLast7Days - 28) * 100) / 100} 小时`)
                : tr(`${result.remainingHours} h left`, `还剩 ${result.remainingHours} 小时`)
        });

        const bars = card.createDiv({ cls: 'jws-day-bars', attr: { 'aria-hidden': 'true' } });
        const maxDay = 8;
        for (let i = 0; i < 7; i++) {
            const day = moment(result.peakWindowStart).add(i, 'days');
            const key = day.format('YYYY-MM-DD');
            const hours = shiftsForCheck
                .filter(s => s.date === key && !s.isPaidLeave)
                .reduce((sum, s) => sum + (s.calculatedHours || 0), 0);
            const col = bars.createDiv({ cls: 'jws-day-bar' });
            const bar = col.createDiv({ cls: 'jws-day-bar-fill' });
            bar.setCssProps({ '--jws-bar': `${Math.min(hours / maxDay, 1) * 100}%` });
            bar.setAttribute('title', `${day.format('M/D')}: ${hours} h`);
            col.createDiv({ cls: 'jws-day-bar-label', text: day.format('D') });
        }

        if (result.mixesVacation && result.totalHoursLast7Days > 0) {
            appendMixedWeekNote(card.createDiv({ cls: `ap-notice ${result.isOverLimit ? 'is-danger' : 'is-warn'} jws-card-note` }).createDiv());
        } else if (tracker.isVacationDay(selected)) {
            card.createDiv({ cls: 'ap-notice is-good jws-card-note', text: tr('Long break: up to 8 h per day.', '长假期间：每天最多 8 小时。') });
        }
        const vacationOver = tracker.findVacationDaysOverLimit(shiftsForCheck);
        if (vacationOver.length > 0) {
            card.createDiv({
                cls: 'ap-notice is-danger jws-card-note',
                text: tr(`Over 8 h on a long-break day: ${vacationOver.map(day => `${moment(day.date).format('M/D')} ${day.hours} h`).join(', ')}`, `长假日超过 8 小时：${vacationOver.map(day => `${moment(day.date).format('M/D')} ${day.hours} 小时`).join('、')}`)
            });
        }

        return {
            start: result.peakWindowStart,
            end: result.peakWindowEnd,
            hours: result.totalHoursLast7Days,
            isOverLimit: result.isOverLimit
        };
    }

    private renderIncomeAnalyticsCard(
        container: HTMLElement,
        calcStart: Moment,
        calcEnd: Moment,
        displayLabel: string,
        monthlyWage: number,
        currentShifts: Shift[]
    ) {
        const card = container.createDiv({ cls: 'ap-card jws-income-card' });
        card.createDiv({ cls: 'ap-label', text: tr('Income', '收入') });

        const previousPeriod = this.getPreviousPeriod(calcStart, calcEnd);
        const previousWage = this.getMonthlyWage(previousPeriod.start, previousPeriod.end);
        const delta = monthlyWage - previousWage;
        const deltaLabel = `${delta >= 0 ? '+' : '-'}¥${Math.abs(delta).toLocaleString()}`;
        const percentLabel = previousWage > 0
            ? `${delta >= 0 ? '+' : ''}${Math.round((delta / previousWage) * 100)}%`
            : (monthlyWage > 0 ? 'new' : '0%');
        const comparison = card.createDiv({ cls: 'ap-split jws-income-delta' });
        comparison.createSpan({ text: tr('vs previous period', '与上期相比') });
        comparison.createSpan({ cls: delta >= 0 ? 'is-up' : 'is-down', text: `${deltaLabel} (${percentLabel})`, attr: { title: displayLabel } });

        const trendRows: { label: string, wage: number }[] = [];
        for (let i = 5; i >= 0; i--) {
            const period = this.getPeriodForDate(this.currentViewDate.clone().subtract(i, 'month'));
            trendRows.push({
                label: this.isPayrollView ? period.start.format('M/D') : period.start.format('MMM'),
                wage: this.getMonthlyWage(period.start, period.end)
            });
        }
        const maxTrendWage = Math.max(1, ...trendRows.map(row => row.wage));
        const trendChart = card.createDiv({ cls: 'jws-trend' });
        trendRows.forEach((row, index) => {
            const wrap = trendChart.createDiv({ cls: `jws-trend-col${index === trendRows.length - 1 ? ' is-current' : ''}` });
            const bar = wrap.createDiv({ cls: 'jws-trend-bar' });
            bar.setCssProps({ '--jws-bar': `${Math.max(4, Math.round((row.wage / maxTrendWage) * 100))}%` });
            bar.setAttribute('title', `${row.label}: ¥${row.wage.toLocaleString()}`);
            wrap.createDiv({ text: row.label, cls: 'jws-trend-label' });
        });

        const storeTotals = new Map<string, number>();
        currentShifts.forEach(shift => {
            storeTotals.set(shift.storeName, (storeTotals.get(shift.storeName) || 0) + (shift.calculatedWage || 0));
        });
        const storeRows = Array.from(storeTotals.entries()).sort((a, b) => b[1] - a[1]);
        const storeTotal = storeRows.reduce((sum, [, wage]) => sum + wage, 0);
        if (storeRows.length === 0 || storeTotal === 0) {
            card.createDiv({ text: tr('No store income in this period', '本期没有收入'), cls: 'ap-cap' });
            return;
        }
        const shareBar = card.createDiv({ cls: 'jws-store-share' });
        storeRows.forEach(([storeName, wage]) => {
            const segment = shareBar.createDiv({ cls: `jws-store-seg ${getStoreColorClass(this.plugin.settings, storeName)}` });
            segment.setCssProps({ '--jws-share': `${(wage / storeTotal) * 100}%` });
            segment.setAttribute('title', `${getStoreShortName(this.plugin.settings, storeName)}: ¥${wage.toLocaleString()}`);
        });
        const legend = card.createDiv({ cls: 'jws-store-legend' });
        storeRows.forEach(([storeName, wage]) => {
            const row = legend.createDiv({ cls: `jws-store-row ${getStoreColorClass(this.plugin.settings, storeName)}` });
            row.createSpan({ cls: 'jws-store-swatch' });
            row.createSpan({ text: `${getStoreShortName(this.plugin.settings, storeName)} ${Math.round((wage / storeTotal) * 100)}%`, cls: 'ap-grow' });
            row.createSpan({ text: `¥${wage.toLocaleString()}`, cls: 'ap-num' });
        });
    }

    renderCalendar(parent: HTMLElement, peak?: { start: string, end: string, hours: number, isOverLimit: boolean }) {
        const calendarGrid = parent.createDiv({ cls: 'jws-cal' });
        const short = moment.weekdaysShort();
        [1, 2, 3, 4, 5, 6, 0].forEach(i => calendarGrid.createDiv({ cls: 'jws-cal-dow', text: short[i] }));

        const startOfMonth = this.currentViewDate.clone().startOf('month');
        const endOfMonth = this.currentViewDate.clone().endOf('month');
        const startOfGrid = startOfMonth.clone().startOf('isoWeek');
        const endOfGrid = endOfMonth.clone().endOf('isoWeek');

        const allShifts = this.getShiftsInRange(startOfGrid, endOfGrid);
        const showPeak = !!peak && peak.hours > 0;

        let curr = startOfGrid.clone();
        while (curr.isBefore(endOfGrid)) {
            const capturedDate = curr.clone();
            const dateStr = capturedDate.format('YYYY-MM-DD');
            const shiftsForDay = allShifts.filter(s => s.date === dateStr);

            const dayEl = calendarGrid.createDiv({ cls: 'jws-day' });
            if (capturedDate.isSame(moment(), 'day')) dayEl.addClass('is-today');
            if (capturedDate.isSame(this.selectedDate, 'day')) dayEl.addClass('is-selected');
            if (capturedDate.month() !== this.currentViewDate.month()) dayEl.addClass('is-other-month');
            if (capturedDate.isoWeekday() >= 6) dayEl.addClass('is-weekend');
            if (showPeak && peak && dateStr >= peak.start && dateStr <= peak.end) {
                dayEl.addClass('in-peak');
                if (peak.isOverLimit) dayEl.addClass('is-over');
                if (dateStr === peak.start) dayEl.addClass('peak-start');
                if (dateStr === peak.end) dayEl.addClass('peak-end');
            }

            dayEl.createDiv({ text: capturedDate.format('D'), cls: 'jws-day-number' });

            const holidayName = HolidayUtility.getHolidayName(dateStr);
            if (holidayName) {
                dayEl.addClass('is-holiday');
                dayEl.setAttribute('title', holidayName);
            }

            dayEl.onClickEvent(() => {
                this.selectedDate = capturedDate.clone();
                this.render();
            });

            // Double click an empty part of the day to add a shift
            dayEl.addEventListener('dblclick', (e) => {
                const target = e.target as HTMLElement;
                if (target.closest('.jws-shift')) return;
                e.stopPropagation();
                new QuickAddShiftModal(this.app, dateStr, this.plugin, () => this.render(), (a, b) => this.getShiftsInRange(a, b)).open();
            });

            shiftsForDay.forEach(s => {
                const isRecurring = parseRecurringInstanceId(s.id) !== null;
                const shiftEl = dayEl.createDiv({
                    cls: `jws-shift ${getStoreColorClass(this.plugin.settings, s.storeName)}${isRecurring ? ' is-recurring' : ''}${s.isPaidLeave ? ' is-paid-leave' : ''}`
                });
                shiftEl.createSpan({ cls: 'jws-shift-store', text: getStoreShortName(this.plugin.settings, s.storeName) });
                shiftEl.createSpan({ cls: 'jws-shift-time', text: s.isPaidLeave ? tr('Paid leave', '带薪假') : `${s.startTime}–${s.endTime}` });
                if (s.isSynced) shiftEl.createSpan({ cls: 'jws-shift-synced', attr: { 'aria-label': tr('Synced to calendar', '已同步到日历') } });
                shiftEl.setAttribute('title', `${s.storeName}\n${s.startTime} - ${s.endTime}\n${tr('Est. wage', '预计工资')}: ¥${s.calculatedWage}${s.isSynced ? `\n${tr('Synced to calendar', '已同步到日历')}` : ''}`);

                shiftEl.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.handleShiftContextMenu(e, s);
                });

                shiftEl.onClickEvent((e) => {
                    e.stopPropagation();
                    // No re-render on single click: it would drop this element and break the double click.
                    this.selectedDate = capturedDate.clone();
                });

                shiftEl.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    void (async () => {
                    if (!this.plugin.ensureScheduleMutationAllowed()) return;
                    const recurringIdParts = parseRecurringInstanceId(s.id);
                    if (recurringIdParts) {
                        // A recurring occurrence becomes a manual shift first, then opens for editing.
                        const rs = this.plugin.shiftData.recurringShifts.find(r => r.id === recurringIdParts.ruleId);
                        if (rs) {
                            rs.exceptions = rs.exceptions || [];
                            if (!rs.exceptions.includes(dateStr)) {
                                rs.exceptions.push(dateStr);
                            }
                            const calculator = new WageCalculator(this.plugin.settings);
                            const res = calculator.calculateShiftWage(dateStr, rs.startTime, rs.endTime, false, undefined, rs.storeName);
                            const newShift: Shift = {
                                id: crypto.randomUUID(),
                                date: dateStr,
                                startTime: rs.startTime,
                                endTime: rs.endTime,
                                storeName: rs.storeName,
                                calculatedHours: res.totalHours,
                                calculatedWage: res.wageAmount,
                                isPaidLeave: false
                            };
                            this.plugin.shiftData.shifts.push(newShift);
                            await this.plugin.saveDataStore();
                            new EditShiftModal(this.plugin.app, newShift, this.plugin, () => this.render()).open();
                        }
                    } else {
                        const shift = this.plugin.shiftData.shifts.find(sh => sh.id === s.id);
                        if (shift) {
                            new EditShiftModal(this.plugin.app, shift, this.plugin, () => this.render()).open();
                        }
                    }
                })();
                });
            });

            curr.add(1, 'day');
        }
    }

    renderWeekView(parent: HTMLElement) {
        const weekGrid = parent.createDiv({ cls: 'jws-week' });

        const startOfWeek = this.currentViewDate.clone().startOf('isoWeek');
        const endOfWeek = this.currentViewDate.clone().endOf('isoWeek');
        const shifts = this.getShiftsInRange(startOfWeek, endOfWeek);

        let curr = startOfWeek.clone();
        while (curr.isSameOrBefore(endOfWeek, 'day')) {
            const capturedDate = curr.clone();
            const column = weekGrid.createDiv({ cls: 'jws-week-col' });
            column.createDiv({ cls: 'jws-cal-dow', text: capturedDate.format(tr('ddd D', 'ddd D日')) });

            const cell = column.createDiv({ cls: 'jws-day jws-week-cell' });
            if (capturedDate.isSame(this.selectedDate, 'day')) cell.addClass('is-selected');
            if (capturedDate.isSame(moment(), 'day')) cell.addClass('is-today');

            cell.onClickEvent(() => {
                this.selectedDate = capturedDate.clone();
                this.render();
            });

            const dayShifts = shifts.filter(s => s.date === capturedDate.format('YYYY-MM-DD'));
            dayShifts.forEach(s => {
                const isRecurring = parseRecurringInstanceId(s.id) !== null;
                const shiftEl = cell.createDiv({
                    cls: `jws-shift ${getStoreColorClass(this.plugin.settings, s.storeName)}${isRecurring ? ' is-recurring' : ''}${s.isPaidLeave ? ' is-paid-leave' : ''}`
                });
                shiftEl.createSpan({ cls: 'jws-shift-store', text: getStoreShortName(this.plugin.settings, s.storeName) });
                shiftEl.createSpan({ cls: 'jws-shift-time', text: s.isPaidLeave ? `${tr('Paid leave', '带薪假')} (${s.storeName})` : `${s.startTime}–${s.endTime}` });
                shiftEl.setAttribute('title', `${s.storeName}\n${tr('Est. wage', '预计工资')}: ¥${s.calculatedWage}`);
                shiftEl.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.handleShiftContextMenu(e, s);
                });
                shiftEl.onClickEvent(async (e) => {
                    e.stopPropagation();
                    this.selectedDate = capturedDate.clone();
                    this.render();
                });
            });

            curr.add(1, 'day');
        }
    }

    renderLeftManagementColumn(parent: HTMLElement) {
        const details = parent.createEl('details', { cls: 'jws-details' });
        details.createEl('summary', { cls: 'ap-label', text: tr('Add a single shift', '加一个班次') });

        const form = details.createDiv({ cls: 'jws-form' });
        const dateInput = field(form, tr('Date', '日期')).createEl('input', { attr: { type: 'date', value: moment().format('YYYY-MM-DD') } });
        const timeRow = form.createDiv({ cls: 'jws-form-row' });
        const startInput = field(timeRow, tr('Start', '开始')).createEl('input', { attr: { type: 'time', value: '17:00' } });
        const endInput = field(timeRow, tr('End', '结束')).createEl('input', { attr: { type: 'time', value: '22:00' } });
        const storeSelect = field(form, tr('Store', '店铺')).createEl('select', { cls: 'dropdown' });
        this.populateStoreSelect(storeSelect);
        const breakInput = field(form, tr('Break taken (minutes)', '休息（分钟）')).createEl('input', { attr: { type: 'number', min: '0', placeholder: tr('Not entered', '未填') } });

        const btn = form.createEl('button', { cls: 'mod-cta', text: tr('Add to records', '加入记录') });
        btn.onClickEvent(async () => {
            if (!this.plugin.ensureScheduleMutationAllowed()) return;
            const date = dateInput.value;
            const start = startInput.value;
            const end = endInput.value;
            const store = storeSelect.value;
            const customBreak = breakInput.value ? Number(breakInput.value) : undefined;

            const hasOverlap = this.plugin.shiftData.shifts.some(s => {
                if (s.date !== date) return false;
                return (start < s.endTime) && (end > s.startTime);
            });
            if (hasOverlap) {
                new Notice(tr('This overlaps an existing shift on the same day.', '和当天已有的班次时间重叠。'));
                return;
            }

            const calculator = new WageCalculator(this.plugin.settings);
            const res = calculator.calculateShiftWage(date, start, end, false, customBreak, store);
            const newShift: Shift = {
                id: crypto.randomUUID(),
                date,
                startTime: start,
                endTime: end,
                storeName: store,
                calculatedHours: res.totalHours,
                calculatedWage: res.wageAmount,
                isPaidLeave: false,
                breakMinutes: customBreak
            };
            this.plugin.shiftData.shifts.push(newShift);
            await this.plugin.saveDataStore();
            new Notice(tr('Shift added.', '已加班次。'));

            try {
                await this.plugin.syncShiftToCalendar(newShift);
                new Notice(tr('Synced to calendar.', '已同步到日历。'));
            } catch (e) {
                new Notice(tr(`Calendar sync failed: ${errorMessage(e)}`, `日历同步失败：${errorMessage(e)}`));
            }

            this.render();
        });

        parent.createDiv({ cls: 'ap-label jws-section-label', text: tr('Recurring shifts', '固定班次') });
        const list = parent.createDiv({ cls: 'jws-recurring-list' });
        const days = moment.weekdaysShort();

        if (this.plugin.shiftData.recurringShifts.length === 0) {
            list.createDiv({ text: tr('No recurring shifts set.', '还没有固定班次。'), cls: 'ap-cap' });
        }

        this.plugin.shiftData.recurringShifts.forEach(rs => {
            const isEditing = this.editingRecurringId === rs.id;
            const item = list.createDiv({ cls: `ap-line jws-recurring${isEditing ? ' is-editing' : ''}` });

            if (isEditing) {
                const editor = item.createDiv({ cls: 'jws-form ap-grow' });
                const row1 = editor.createDiv({ cls: 'jws-form-row' });
                const daySel = row1.createEl('select', { cls: 'dropdown' });
                days.forEach((d, i) => { const opt = daySel.createEl('option', { text: d }); opt.value = i.toString(); if (i === rs.dayOfWeek) opt.selected = true; });
                const storeSel = row1.createEl('select', { cls: 'dropdown' });
                this.populateStoreSelect(storeSel, rs.storeName);
                const row2 = editor.createDiv({ cls: 'jws-form-row' });
                const startIn = row2.createEl('input', { attr: { type: 'time', value: rs.startTime } });
                const endIn = row2.createEl('input', { attr: { type: 'time', value: rs.endTime } });
                const row3 = editor.createDiv({ cls: 'jws-form-row' });
                const startDateIn = row3.createEl('input', { attr: { type: 'date', value: rs.startDate || '' } });
                const endDateIn = row3.createEl('input', { attr: { type: 'date', value: rs.endDate || '' } });

                const editActions = editor.createDiv({ cls: 'ap-actions' });
                const cancelBtn = editActions.createEl('button', { text: tr('Cancel', '取消') });
                const saveBtn = editActions.createEl('button', { text: tr('Save', '保存'), cls: 'mod-cta' });
                saveBtn.onClickEvent(async () => {
                    if (!this.plugin.ensureScheduleMutationAllowed()) return;
                    rs.dayOfWeek = parseInt(daySel.value);
                    rs.storeName = storeSel.value;
                    rs.startTime = startIn.value;
                    rs.endTime = endIn.value;
                    rs.startDate = startDateIn.value || undefined;
                    rs.endDate = endDateIn.value || undefined;
                    await this.plugin.saveDataStore();
                    this.editingRecurringId = null;
                    this.render();
                });
                cancelBtn.onClickEvent(() => { this.editingRecurringId = null; this.render(); });
            } else {
                item.createSpan({ cls: `ap-pill jws-store-chip ${getStoreColorClass(this.plugin.settings, rs.storeName)}`, text: getStoreShortName(this.plugin.settings, rs.storeName) });
                item.createSpan({ cls: 'ap-grow ap-num', text: `${days[rs.dayOfWeek]} ${rs.startTime}–${rs.endTime}` });
                const editIcon = item.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': tr('Edit recurring shift', '编辑固定班次') } });
                setIcon(editIcon, 'pencil');
                const delBtn = item.createEl('button', { cls: 'clickable-icon jws-danger-icon', attr: { 'aria-label': tr('Delete recurring shift', '删除固定班次') } });
                setIcon(delBtn, 'trash-2');

                editIcon.onClickEvent(() => { this.editingRecurringId = rs.id; this.render(); });
                armDelete(delBtn, tr('Delete recurring shift', '删除固定班次'), async () => {
                    if (!this.plugin.ensureScheduleMutationAllowed()) return;
                    this.plugin.shiftData.recurringShifts = this.plugin.shiftData.recurringShifts.filter(r => r.id !== rs.id);
                    await this.plugin.saveDataStore();
                    this.render();
                });
            }
        });
    }

    renderRightManagementColumn(parent: HTMLElement) {
        const addSection = parent.createDiv({ cls: 'add-recurring-section' });
        
        const gridWrapper = addSection.createDiv({ cls: 'weekly-pattern-grid' });
        const days = moment.weekdaysShort();
        
        days.forEach((dayName, i) => {
            const row = gridWrapper.createDiv({ cls: 'pattern-row' });
            
            // Checkbox + Day Name
            const checkLabel = row.createEl('label', { cls: 'day-check-label' });
            const check = checkLabel.createEl('input', { attr: { type: 'checkbox' } });
            check.checked = this.weeklyPattern[i].active;
            checkLabel.createSpan({ text: dayName });
            
            check.onchange = () => {
                this.weeklyPattern[i].active = check.checked;
            };

            // Times (only visible if active? or just enabled/disabled)
            const timeGroup = row.createDiv({ cls: 'pattern-times' });
            const startIn = timeGroup.createEl('input', { attr: { type: 'time', value: this.weeklyPattern[i].start } });
            const endIn = timeGroup.createEl('input', { attr: { type: 'time', value: this.weeklyPattern[i].end } });
            
            startIn.onchange = () => this.weeklyPattern[i].start = startIn.value;
            endIn.onchange = () => this.weeklyPattern[i].end = endIn.value;
        });

        const batchControls = addSection.createDiv({ cls: 'batch-controls' });

        const seedWeekStart = this.selectedDate.clone().startOf('isoWeek');
        const seedWeekEnd = seedWeekStart.clone().add(6, 'days');
        const seedLabel = seedWeekStart.format('YYYY-MM-DD');
        const seedTemplateBtn = batchControls.createEl('button', {
            text: tr(`Build template from the ${seedLabel} week`, `用 ${seedLabel} 那周生成模板`),
            cls: 'jws-small-btn'
        });
        seedTemplateBtn.onClickEvent(async () => {
            const count = await this.saveTemplateFromRange(seedWeekStart, seedWeekEnd, `${seedLabel} weekly pattern`);
            new Notice(count > 0
                ? tr(`Saved ${seedLabel} weekly template (${count} shift pattern(s)).`, `已存 ${seedLabel} 那周的模板（${count} 个班次）。`)
                : tr(`No shifts found for ${seedLabel} to ${seedWeekEnd.format('YYYY-MM-DD')}.`, `${seedLabel} 到 ${seedWeekEnd.format('YYYY-MM-DD')} 没有班次。`));
            this.render();
        });

        const templateNameInput = batchControls.createEl('input', {
            attr: {
                type: 'text',
                value: this.templateName,
                placeholder: tr('Template name', '模板名称'),
            }
        });
        templateNameInput.oninput = () => this.templateName = templateNameInput.value || 'Regular weekly pattern';

        const storeSel = batchControls.createEl('select', { cls: 'dropdown' });
        const selectedStore = this.weeklyPatternStoreName || this.getStoreOptions()[0]?.name;
        this.populateStoreSelect(storeSel, selectedStore);
        storeSel.onchange = () => this.weeklyPatternStoreName = storeSel.value;

        const dateRow = batchControls.createDiv({ cls: 'batch-date-row' });
        const startD = dateRow.createEl('input', { attr: { type: 'date', value: this.batchStartDate, placeholder: tr('Start date', '开始日期') } });
        const endD = dateRow.createEl('input', { attr: { type: 'date', value: this.batchEndDate, placeholder: tr('End date', '结束日期') } });
        
        startD.onchange = () => this.batchStartDate = startD.value;
        endD.onchange = () => this.batchEndDate = endD.value;

        const actionRow = batchControls.createDiv({ cls: 'template-action-row' });
        const saveTemplateBtn = actionRow.createEl('button', { text: tr('Save template', '存为模板') });
        const addBtn = actionRow.createEl('button', { text: tr('Create rules', '生成规则'), cls: 'mod-cta' });

        saveTemplateBtn.onClickEvent(async () => {
            const patterns = this.getActiveTemplatePatterns(storeSel.value);
            if (patterns.length === 0) {
                new Notice(tr('Please select at least one day.', '请至少选一天。'));
                return;
            }

            this.plugin.shiftData.shiftTemplates = this.plugin.shiftData.shiftTemplates || [];
            const now = moment().toISOString();
            this.plugin.shiftData.shiftTemplates.push({
                id: crypto.randomUUID(),
                name: templateNameInput.value.trim() || 'Regular weekly pattern',
                patterns,
                createdAt: now,
                updatedAt: now
            });

            await this.plugin.saveDataStore();
            new Notice(tr(`Saved template with ${patterns.length} day(s).`, `已存模板，共 ${patterns.length} 天。`));
            this.render();
        });

        addBtn.onClickEvent(async () => {
            const patterns = this.getActiveTemplatePatterns(storeSel.value);
            if (patterns.length === 0) {
                new Notice(tr('Please select at least one day.', '请至少选一天。'));
                return;
            }

            const added = await this.createRecurringRulesFromPatterns(patterns, this.batchStartDate, this.batchEndDate);
            if (added < 0) return;
            new Notice(added > 0 ? tr(`Added ${added} recurring rule(s).`, `新增 ${added} 条固定规则。`) : tr('No new rules added; matching rules already exist.', '没有新增规则，相同的规则已存在。'));
            this.render();
        });

        const templates = this.plugin.shiftData.shiftTemplates || [];
        const templateList = addSection.createDiv({ cls: 'template-list' });
        templateList.createDiv({ cls: 'ap-label jws-section-label', text: tr('Saved templates', '已存模板') });

        if (templates.length === 0) {
            templateList.createDiv({ text: tr('No templates saved yet.', '还没有模板。'), cls: 'ap-cap' });
            return;
        }

        templates.forEach(template => {
            const row = templateList.createDiv({ cls: 'ap-line template-item' });
            const info = row.createDiv({ cls: 'ap-grow' });
            info.createDiv({ text: template.name, cls: 'template-item-title' });
            const summary = template.patterns
                .map(pattern => `${days[pattern.dayOfWeek]} ${pattern.startTime}-${pattern.endTime} ${getStoreShortName(this.plugin.settings, pattern.storeName)}`)
                .join(' / ');
            info.createDiv({ text: summary, cls: 'ap-cap' });

            const actions = row.createDiv({ cls: 'template-item-actions' });
            const loadBtn = actions.createEl('button', { text: tr('Load', '载入') });
            const applyBtn = actions.createEl('button', { text: tr('Range', '按日期范围') });
            const thisMonthBtn = actions.createEl('button', { text: tr('This work month', '本工资月') });
            const nextMonthBtn = actions.createEl('button', { text: tr('Next Work Month', '下个工资月') });
            const deleteBtn = actions.createEl('button', { cls: 'clickable-icon jws-danger-icon', attr: { 'aria-label': tr('Delete template', '删除模板') } });
            setIcon(deleteBtn, 'trash-2');

            loadBtn.onClickEvent(() => {
                this.templateName = template.name;
                this.loadTemplateIntoEditor(template.patterns);
                this.render();
            });

            applyBtn.onClickEvent(async () => {
                const added = await this.createRecurringRulesFromPatterns(template.patterns, this.batchStartDate, this.batchEndDate);
                if (added < 0) return;
                new Notice(added > 0 ? tr(`Applied template: ${added} recurring rule(s).`, `已套用模板：${added} 条固定规则。`) : tr('No new rules added; matching rules already exist.', '没有新增规则，相同的规则已存在。'));
                this.render();
            });

            thisMonthBtn.onClickEvent(async () => {
                const period = this.getWorkMonthPeriod(this.currentViewDate);
                const added = await this.applyTemplateToWorkMonth(template.patterns, period);
                if (added < 0) return;
                new Notice(added > 0 ? tr(`Scheduled ${period.label} with ${added} recurring rule(s).`, `已为 ${period.label} 排好 ${added} 条固定规则。`) : tr(`${period.label} already has matching rules.`, `${period.label} 已有相同的规则。`));
                this.currentViewDate = period.start.clone();
                this.selectedDate = period.start.clone();
                this.activeDashboardTab = 'calendar';
                this.render();
            });

            nextMonthBtn.onClickEvent(async () => {
                const period = this.getNextWorkMonthPeriod(this.currentViewDate);
                const added = await this.applyTemplateToWorkMonth(template.patterns, period);
                if (added < 0) return;
                new Notice(added > 0 ? tr(`Scheduled ${period.label} with ${added} recurring rule(s).`, `已为 ${period.label} 排好 ${added} 条固定规则。`) : tr(`${period.label} already has matching rules.`, `${period.label} 已有相同的规则。`));
                this.currentViewDate = period.start.clone();
                this.selectedDate = period.start.clone();
                this.activeDashboardTab = 'calendar';
                this.render();
            });

            armDelete(deleteBtn, tr(`Delete template ${template.name}`, `删除模板 ${template.name}`), async () => {
                this.plugin.shiftData.shiftTemplates = templates.filter(t => t.id !== template.id);
                await this.plugin.saveDataStore();
                this.render();
            });
        });
    }

    private handleShiftContextMenu(e: MouseEvent, s: Shift) {
        const menu = new Menu();
        const recurringParts = parseRecurringInstanceId(s.id);
        const isRecurring = recurringParts !== null;

        if (isRecurring) {
            menu.addItem((item) => {
                item.setTitle(tr('Edit this occurrence only', '只改这一次'))
                    .setIcon('pencil')
                    .onClick(async () => {
                        if (!this.plugin.ensureScheduleMutationAllowed()) return;
                        const rsId = recurringParts?.ruleId;
                        if (!rsId) return;
                        const rs = this.plugin.shiftData.recurringShifts.find(r => r.id === rsId);
                        if (rs) {
                            rs.exceptions = rs.exceptions || [];
                            if (!rs.exceptions.includes(s.date)) {
                                rs.exceptions.push(s.date);
                            }
                            const calculator = new WageCalculator(this.plugin.settings);
                            const res = calculator.calculateShiftWage(s.date, rs.startTime, rs.endTime, false, undefined, rs.storeName);
                            const newShift: Shift = {
                                id: crypto.randomUUID(),
                                date: s.date,
                                startTime: rs.startTime,
                                endTime: rs.endTime,
                                storeName: rs.storeName,
                                calculatedHours: res.totalHours,
                                calculatedWage: res.wageAmount,
                                isPaidLeave: false
                            };
                            this.plugin.shiftData.shifts.push(newShift);
                            await this.plugin.saveDataStore();
                            // 转换完立即打开编辑 Modal
                            new EditShiftModal(this.plugin.app, newShift, this.plugin, () => this.render()).open();
                        }
                    });
            });
            menu.addItem((item) => {
                item.setTitle(tr('Delete this occurrence only', '只删这一次'))
                    .setIcon('calendar-x')
                    .onClick(async () => {
                        if (!this.plugin.ensureScheduleMutationAllowed()) return;
                        const rsId = recurringParts?.ruleId;
                        if (!rsId) return;
                        const rs = this.plugin.shiftData.recurringShifts.find(r => r.id === rsId);
                        if (!rs) return;

                        rs.exceptions = rs.exceptions || [];
                        if (!rs.exceptions.includes(s.date)) {
                            rs.exceptions.push(s.date);
                            rs.exceptions.sort();
                            await this.plugin.saveDataStore();
                            new Notice(tr(`Deleted only ${moment(s.date).format('MM/DD')} occurrence.`, `只删了 ${moment(s.date).format('MM/DD')} 这一次。`));
                        }
                        this.render();
                    });
            });
            menu.addItem((item) => {
                item.setTitle(tr('Delete entire Recurring Rule', '删除整条固定规则'))
                    .setIcon('trash')
                    .onClick(async () => {
                        if (!this.plugin.ensureScheduleMutationAllowed()) return;
                        const rsId = recurringParts?.ruleId;
                        if (!rsId) return;
                        this.plugin.shiftData.recurringShifts = this.plugin.shiftData.recurringShifts.filter(r => r.id !== rsId);
                        await this.plugin.saveDataStore();
                        this.render();
                    });
            });
        } else {
            menu.addItem((item) => {
                item.setTitle(tr('Edit Shift', '编辑班次'))
                    .setIcon('pencil')
                    .onClick(() => {
                        const shift = this.plugin.shiftData.shifts.find(sh => sh.id === s.id);
                        if (shift) {
                            new EditShiftModal(this.plugin.app, shift, this.plugin, () => this.render()).open();
                        }
                    });
            });
            menu.addItem((item) => {
                item.setTitle(s.isPaidLeave ? tr('Unmark paid leave', '取消带薪假') : tr('Mark as paid leave', '标为带薪假'))
                    .setIcon('check-circle')
                    .onClick(async () => {
                        const shift = this.plugin.shiftData.shifts.find(sh => sh.id === s.id);
                        if (shift) {
                            shift.isPaidLeave = !shift.isPaidLeave;
                            const calculator = new WageCalculator(this.plugin.settings);
                            const res = calculator.calculateShiftWage(shift.date, shift.startTime, shift.endTime, shift.isPaidLeave, shift.breakMinutes, shift.storeName);
                            shift.calculatedHours = res.totalHours;
                            shift.calculatedWage = res.wageAmount;
                            await this.plugin.saveDataStore();
                            this.render();
                        }
                    });
            });
            menu.addItem((item) => {
                item.setTitle(tr('Delete Shift', '删除班次'))
                    .setIcon('trash')
                    .onClick(async () => {
                        if (!this.plugin.ensureScheduleMutationAllowed()) return;
                        const shift = this.plugin.shiftData.shifts.find(sh => sh.id === s.id);
                        if (shift && this.plugin.hasShiftCalendarRecord(shift.id)) {
                            try {
                                await this.plugin.deleteShiftFromCalendar(shift);
                            } catch (error) {
                                console.error('Calendar delete failed.', error);
                                new Notice(tr('Calendar delete failed; local shift was still removed.', '日历里没能删掉，本地班次已删除。'));
                            }
                        }
                        this.plugin.shiftData.shifts = this.plugin.shiftData.shifts.filter(sh => sh.id !== s.id);
                        await this.plugin.saveDataStore();
                        this.render();
                    });
            });
        }

        menu.showAtMouseEvent(e);
    }

    private getMonthlyWage(start: Moment, end: Moment): number {
        const shifts = this.getShiftsInRange(start, end);
        return this.calculateTotalSum(shifts);
    }

    private getAnnualWage(start: Moment, end: Moment): number {
        const allShifts = this.getShiftsInRange(start, end);
        return this.calculateTotalSum(allShifts);
    }

    private calculateTotalSum(shifts: Shift[]): number {
        const dayGroups: { [key: string]: Shift[] } = {};
        for (const s of shifts) {
            if (!dayGroups[s.date]) dayGroups[s.date] = [];
            dayGroups[s.date].push(s);
        }

        let total = 0;
        const weeklyHours: { [key: string]: number } = {};
        const weeklyOtPaid: { [key: string]: number } = {};
        const weeklyBaseWage: { [key: string]: number } = {};

        for (const date in dayGroups) {
            const dayShifts = dayGroups[date];
            let dayWage = dayShifts.reduce((acc, s) => acc + s.calculatedWage, 0);
            
            // Daily combined overtime logic
            const totalHours = dayShifts.reduce((acc, s) => acc + s.calculatedHours, 0);
            let dayOtHours = 0;

            if (totalHours > 8) {
                const singleShiftMaxHours = Math.max(...dayShifts.map(s => s.calculatedHours));
                const combinedOtHours = totalHours - 8;
                
                const alreadyPaidOtHours = singleShiftMaxHours > 8 ? (singleShiftMaxHours - 8) : 0;
                const extraOtHours = combinedOtHours - alreadyPaidOtHours;

                if (extraOtHours > 0) {
                    const baseWage = Math.max(...dayShifts.map(s => Number(getStoreWageBand(this.plugin.settings, s.storeName, s.date).baseWage)));
                    const bonus = extraOtHours * baseWage * (Number(this.plugin.settings.overtimeRate) - 1);
                    dayWage += bonus;
                    dayOtHours += extraOtHours;
                }
                dayOtHours += alreadyPaidOtHours;
            }
            total += dayWage;

            // Track for weekly thresholds
            const weekKey = moment(date).format('YYYY-GGGG-WW'); // Full year + ISO week
            weeklyHours[weekKey] = (weeklyHours[weekKey] || 0) + totalHours;
            weeklyOtPaid[weekKey] = (weeklyOtPaid[weekKey] || 0) + dayOtHours;
            weeklyBaseWage[weekKey] = Math.max(weeklyBaseWage[weekKey] || 0, ...dayShifts.map(s => Number(getStoreWageBand(this.plugin.settings, s.storeName, s.date).baseWage)));
        }

        // Apply Weekly Overtime (40h)
        for (const weekKey in weeklyHours) {
            const hours = weeklyHours[weekKey];
            const otPaid = weeklyOtPaid[weekKey] || 0;
            if (hours > 40) {
                const remainingOver40 = hours - 40;
                const extraWeeklyOt = remainingOver40 - otPaid; // Deduct already paid daily OT
                if (extraWeeklyOt > 0) {
                    const baseWage = weeklyBaseWage[weekKey] || Number(this.plugin.settings.baseWage);
                    const bonus = extraWeeklyOt * baseWage * (Number(this.plugin.settings.overtimeRate) - 1);
                    total += bonus;
                }
            }
        }

        return Math.floor(total);
    }

    private renderTaxStrategyCard(container: HTMLElement, monthly: number, annual: number) {
        const card = container.createDiv({ cls: 'ap-card' });
        const headerRow = card.createDiv({ cls: 'jws-card-head' });
        headerRow.createDiv({ cls: 'ap-label', text: tr('Income alerts', '收入提醒') });
        const infoBtn = headerRow.createEl('button', { text: tr('Rules', '规则'), cls: 'jws-small-btn', attr: { title: tr('Official sources for the 28-hour rule and income thresholds', '28 小时规则和收入门槛的官方出处') } });
        infoBtn.onClickEvent(() => {
            new PolicyExplanationModal(this.plugin.app).open();
        });

        const alerts = (this.plugin.settings.incomeAlerts || []).filter(alert => alert.enabled && alert.amount > 0);
        if (alerts.length === 0) {
            card.createDiv({ cls: 'ap-cap', text: tr('No income alerts set. Add the amounts for this year in Settings → Income Alerts.', '还没设收入提醒。到 设置 → 收入提醒 填今年的金额。') });
        }
        for (const alert of alerts) {
            const current = alert.period === 'annual' ? annual : monthly;
            this.createTaxItem(card, alert.label, current, alert.amount, this.getWallStatus(current, alert.amount));
        }
    }

    private getWallStatus(current: number, wall: number): 'safe' | 'near' | 'danger' {
        const ratio = current / wall;
        if (ratio > 1) return 'danger';
        if (ratio > 0.85) return 'near';
        return 'safe';
    }

    private createTaxItem(container: HTMLElement, label: string, current: number, wall: number, status: 'safe' | 'near' | 'danger') {
        const tone = status === 'danger' ? 'is-danger' : status === 'near' ? 'is-warn' : 'is-good';
        const item = container.createDiv({ cls: 'jws-meter-item' });
        const top = item.createDiv({ cls: 'ap-split jws-meter-top' });
        top.createSpan({ text: label });
        top.createSpan({ cls: `ap-pill ${tone}`, text: status === 'danger' ? 'over' : status === 'near' ? 'close' : 'ok' });
        // The text shows the real share, the bar stops at full.
        const percent = Math.round((current / wall) * 100);
        const meter = item.createDiv({ cls: `ap-meter ${tone}` });
        meter.createDiv({ cls: 'ap-meter-fill' }).setCssProps({ '--ap-value': `${Math.min(100, percent)}%` });
        item.createDiv({ cls: 'ap-cap ap-num', text: `¥${current.toLocaleString()} / ¥${wall.toLocaleString()} (${percent}%)` });
    }

    private renderLegalStatusCard(containerEl: HTMLElement) {
        const card = containerEl.createDiv({ cls: 'ap-card' });
        card.createDiv({ cls: 'ap-label', text: tr('Paid leave and overtime', '带薪假和加班') });

        const leaveBalance = this.plugin.settings.paidLeaveBalance || 0;
        const usedLeave = this.plugin.shiftData.shifts.filter(s => s.isPaidLeave).length;
        const remainingLeave = leaveBalance - usedLeave;
        const leaveItem = card.createDiv({ cls: 'jws-meter-item' });
        const leaveTop = leaveItem.createDiv({ cls: 'ap-split jws-meter-top' });
        leaveTop.createSpan({ text: tr('Paid leave (有給休暇)', '带薪假（有給休暇）') });
        leaveTop.createSpan({ cls: 'ap-num', text: tr(`${remainingLeave} / ${leaveBalance} days left`, `剩 ${remainingLeave} / ${leaveBalance} 天`) });
        const leaveMeter = leaveItem.createDiv({ cls: `ap-meter ${remainingLeave <= 1 ? 'is-danger' : 'is-good'}` });
        leaveMeter.createDiv({ cls: 'ap-meter-fill' }).setCssProps({ '--ap-value': `${leaveBalance > 0 ? Math.max(0, remainingLeave / leaveBalance) * 100 : 0}%` });

        // Weekly overtime (current week)
        const weekShifts = this.getShiftsInRange(moment().startOf('week'), moment().endOf('week'));
        const totalHours = weekShifts.reduce((sum, s) => sum + s.calculatedHours, 0);
        const otItem = card.createDiv({ cls: 'jws-meter-item' });
        const otTop = otItem.createDiv({ cls: 'ap-split jws-meter-top' });
        otTop.createSpan({ text: tr('This week', '本周') });
        otTop.createSpan({ cls: 'ap-num', text: `${totalHours.toFixed(1)} / 40 h` });
        const otMeter = otItem.createDiv({ cls: `ap-meter ${totalHours > 40 ? 'is-danger' : ''}`.trim() });
        otMeter.createDiv({ cls: 'ap-meter-fill' }).setCssProps({ '--ap-value': `${Math.min(100, (totalHours / 40) * 100)}%` });
        if (totalHours > 40) {
            otItem.createDiv({ cls: 'ap-notice is-danger jws-card-note', text: tr('Weekly overtime: hours over 40 are paid at the overtime rate.', '周加班：超过 40 小时的部分按加班费率计。') });
        }
    }

    private renderWeeklyChart(parent: HTMLElement) {
        parent.createDiv({ cls: 'ap-label', text: tr('Last 7 days', '最近 7 天') });
        const chart = parent.createDiv({ cls: 'jws-day-bars is-wide' });
        const maxHours = 8;
        for (let i = 6; i >= 0; i--) {
            const d = moment().subtract(i, 'days');
            const totalHours = this.getShiftsInRange(d, d).reduce((sum, s) => sum + s.calculatedHours, 0);
            const col = chart.createDiv({ cls: 'jws-day-bar' });
            const bar = col.createDiv({ cls: `jws-day-bar-fill${totalHours > 0 ? '' : ' is-empty'}` });
            bar.setCssProps({ '--jws-bar': `${Math.min(100, (totalHours / maxHours) * 100)}%` });
            bar.setAttribute('title', `${totalHours} h on ${d.format('MM/DD')}`);
            col.createDiv({ cls: 'jws-day-bar-label', text: d.format('dd') });
        }
    }
}

class ShiftShareModal extends Modal {
    private start: Moment;
    private end: Moment;
    private getShifts: (start: Moment, end: Moment) => Shift[];
    private calculateTotal: (shifts: Shift[]) => number;

    constructor(
        app: App,
        start: Moment,
        end: Moment,
        getShifts: (start: Moment, end: Moment) => Shift[],
        calculateTotal: (shifts: Shift[]) => number,
        private plugin: JapanWorkSecretaryPlugin
    ) {
        super(app);
        this.start = start.clone();
        this.end = end.clone();
        this.getShifts = getShifts;
        this.calculateTotal = calculateTotal;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        this.modalEl.addClass('jws-modal');
        this.modalEl.addClass('ap', 'ap-modal');
        this.titleEl.setText(tr('Share or export', '分享或导出'));

        const form = contentEl.createDiv({ cls: 'jws-form-row' });
        const startInput = field(form, tr('Start date', '开始日期')).createEl('input', { attr: { type: 'date', value: this.start.format('YYYY-MM-DD') } });
        const endInput = field(form, tr('End date', '结束日期')).createEl('input', { attr: { type: 'date', value: this.end.format('YYYY-MM-DD') } });

        const preview = contentEl.createEl('textarea', { cls: 'jws-share-preview' });
        preview.readOnly = true;

        const updatePreview = () => {
            const start = moment(startInput.value, 'YYYY-MM-DD');
            const end = moment(endInput.value, 'YYYY-MM-DD');
            preview.value = this.buildShareText(start, end);
        };

        startInput.onchange = updatePreview;
        endInput.onchange = updatePreview;
        updatePreview();

        const actions = contentEl.createDiv({ cls: 'ap-modal-foot' });
        actions.createDiv({ cls: 'ap-foot-note', text: tr('Text for a chat message, an image, a pay note, or a calendar file.', '可以导出聊天用的文字、图片、工资笔记或日历文件。') });
        const closeBtn = actions.createEl('button', { text: tr('Close', '关闭') });
        const noteBtn = actions.createEl('button', { text: tr('Save pay note', '存工资笔记'), attr: { 'aria-label': tr('Save a note with every shift and the pay for this range, to compare with your payslip', '把这段时间的每个班次和工资存成笔记，方便对照工资条') } });
        const icsBtn = actions.createEl('button', { text: tr('Export .ics', '导出 .ics'), attr: { 'aria-label': tr('Save a calendar file for Google Calendar, Outlook or your phone', '存成日历文件，导入 Google 日历、Outlook 或手机') } });
        const imageBtn = actions.createEl('button', { text: tr('Download PNG', '下载 PNG') });
        const copyBtn = actions.createEl('button', { text: tr('Copy text', '复制文字'), cls: 'mod-cta' });

        const range = (): { start: Moment, end: Moment } | null => {
            const start = moment(startInput.value, 'YYYY-MM-DD');
            const end = moment(endInput.value, 'YYYY-MM-DD');
            if (!start.isValid() || !end.isValid() || end.isBefore(start, 'day')) {
                new Notice(tr('Pick a valid date range first.', '请先选有效的日期范围。'));
                return null;
            }
            return { start, end };
        };
        noteBtn.onClickEvent(async () => {
            const r = range();
            if (!r) return;
            const shifts = this.getShifts(r.start, r.end);
            await this.plugin.savePayNote(shifts, r.start.format('YYYY-MM-DD'), r.end.format('YYYY-MM-DD'), this.calculateTotal(shifts));
            this.close();
        });
        icsBtn.onClickEvent(async () => {
            const r = range();
            if (!r) return;
            await this.plugin.exportIcs(this.getShifts(r.start, r.end));
        });

        copyBtn.onClickEvent(async () => {
            await this.copyText(preview.value);
            new Notice(tr('Schedule text copied.', '已复制排班文字。'));
        });

        imageBtn.onClickEvent(async () => {
            const start = moment(startInput.value, 'YYYY-MM-DD');
            const end = moment(endInput.value, 'YYYY-MM-DD');
            await this.downloadImage(this.buildShareText(start, end), start, end);
        });

        closeBtn.onClickEvent(() => this.close());
    }

    private buildShareText(start: Moment, end: Moment): string {
        if (!start.isValid() || !end.isValid()) {
            return tr('Invalid date range.', '日期范围无效。');
        }

        if (end.isBefore(start, 'day')) {
            return tr('End date must be after start date.', '结束日期要晚于开始日期。');
        }

        const shifts = this.getShifts(start, end);
        const totalHours = shifts.reduce((sum, shift) => sum + (shift.calculatedHours || 0), 0);
        const totalWage = this.calculateTotal(shifts);
        const lines = [
            `Shifts ${start.format('YYYY/MM/DD')} - ${end.format('YYYY/MM/DD')}`,
            `Total ${Math.round(totalHours * 10) / 10}h / estimated wage ¥${totalWage.toLocaleString()}`,
            ''
        ];

        if (shifts.length === 0) {
            lines.push('No shifts');
            return lines.join('\n');
        }

        const grouped: { [date: string]: Shift[] } = {};
        shifts.forEach(shift => {
            grouped[shift.date] = grouped[shift.date] || [];
            grouped[shift.date].push(shift);
        });

        Object.keys(grouped).sort().forEach(date => {
            lines.push(`${moment(date).format('MM/DD ddd')}`);
            grouped[date]
                .sort((a, b) => a.startTime.localeCompare(b.startTime))
                .forEach(shift => {
                    const label = shift.isPaidLeave
                        ? `Paid leave ${shift.storeName}`
                        : `${shift.startTime}-${shift.endTime} ${shift.storeName}`;
                    lines.push(`  ${label} (${shift.calculatedHours}h / ¥${Number(shift.calculatedWage || 0).toLocaleString()})`);
                });
        });

        return lines.join('\n');
    }

    private async copyText(text: string) {
        await navigator.clipboard.writeText(text);
    }

    private async downloadImage(text: string, start: Moment, end: Moment) {
        const lines = text.split('\n');
        const width = 900;
        const height = Math.max(260, 122 + lines.length * 30);
        const escapedLines = lines.map((line, index) => {
            const y = 72 + index * 30;
            const weight = index === 0 ? '700' : '500';
            const size = index === 0 ? '28' : '20';
            return `<text x="48" y="${y}" font-size="${size}" font-weight="${weight}" fill="#172033">${this.escapeXml(line || ' ')}</text>`;
        }).join('');
        const svg = [
            `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
            '<rect width="100%" height="100%" rx="28" fill="#f8fafc"/>',
            '<rect x="24" y="24" width="852" height="' + (height - 48) + '" rx="22" fill="#ffffff" stroke="#d8dee8"/>',
            '<text x="48" y="42" font-size="14" font-weight="700" fill="#667085">Japan Work Secretary</text>',
            escapedLines,
            '</svg>'
        ].join('');

        const fileStem = `schedule_${start.format('YYYYMMDD')}_${end.format('YYYYMMDD')}`;
        const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });

        try {
            const pngBlob = await this.svgBlobToPng(svgBlob, width, height);
            this.downloadBlob(pngBlob, `${fileStem}.png`);
            new Notice(tr('Schedule image exported.', '已导出排班图片。'));
        } catch (error) {
            console.error('PNG export failed; falling back to SVG.', error);
            this.downloadBlob(svgBlob, `${fileStem}.svg`);
            new Notice(tr('PNG export failed; SVG image exported instead.', 'PNG 导出失败，改为导出 SVG。'));
        }
    }

    private svgBlobToPng(svgBlob: Blob, width: number, height: number): Promise<Blob> {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(svgBlob);
            const img = new Image();
            img.onload = () => {
                const canvas = createEl('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    URL.revokeObjectURL(url);
                    reject(new Error('Canvas is unavailable.'));
                    return;
                }

                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, width, height);
                ctx.drawImage(img, 0, 0);
                canvas.toBlob(blob => {
                    URL.revokeObjectURL(url);
                    if (blob) resolve(blob);
                    else reject(new Error('Canvas export failed.'));
                }, 'image/png');
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('SVG render failed.'));
            };
            img.src = url;
        });
    }

    private downloadBlob(blob: Blob, fileName: string) {
        const url = URL.createObjectURL(blob);
        const link = createEl('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    private escapeXml(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    onClose() {
        this.contentEl.empty();
    }
}

/**
 * Deleting takes a second click within four seconds, like the rest of the plugin,
 * instead of a browser dialog.
 */
function armDelete(button: HTMLElement, label: string, onDelete: () => Promise<void>) {
    let armed = false;
    button.setAttr('aria-label', label);
    button.onClickEvent(() => {
        if (!armed) {
            armed = true;
            button.addClass('is-armed');
            button.setAttr('aria-label', 'Click again to delete');
            window.setTimeout(() => { armed = false; button.removeClass('is-armed'); button.setAttr('aria-label', label); }, 4000);
            return;
        }
        void onDelete();
    });
}

// ─── Shift modals ─────────────────────────────────────────────────────────────

/** Shared look for the plugin's modals: own class, the glass sheet, title in the header. */
function prepareModal(modal: Modal, plugin: JapanWorkSecretaryPlugin, title: string) {
    modal.modalEl.addClass('jws-modal');
    modal.modalEl.addClass('ap', 'ap-modal');
    modal.titleEl.setText(title);
}

function field(parent: HTMLElement, label: string): HTMLElement {
    const group = parent.createDiv({ cls: 'jws-field' });
    group.createEl('label', { text: label });
    return group;
}

class EditShiftModal extends Modal {
    private shift: Shift;
    private plugin: JapanWorkSecretaryPlugin;
    private onSave: () => void;

    constructor(app: App, shift: Shift, plugin: JapanWorkSecretaryPlugin, onSave: () => void) {
        super(app);
        this.shift = shift;
        this.plugin = plugin;
        this.onSave = onSave;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        prepareModal(this, this.plugin, tr('Edit shift', '编辑班次'));

        const form = contentEl.createDiv({ cls: 'jws-form' });
        const dateInput = field(form, tr('Date', '日期')).createEl('input', { attr: { type: 'date', value: this.shift.date } });
        const timeRow = form.createDiv({ cls: 'jws-form-row' });
        const startInput = field(timeRow, tr('Start', '开始')).createEl('input', { attr: { type: 'time', value: this.shift.startTime } });
        const endInput = field(timeRow, tr('End', '结束')).createEl('input', { attr: { type: 'time', value: this.shift.endTime } });
        const storeSelect = field(form, tr('Store', '店铺')).createEl('select', { cls: 'dropdown' });
        normalizeStoreConfigs(this.plugin.settings.storeConfigs).forEach(store => {
            const opt = storeSelect.createEl('option', { text: store.name });
            opt.value = store.name;
            if (store.name === this.shift.storeName) opt.selected = true;
        });

        const preview = contentEl.createDiv({ cls: 'ap-card is-flat jws-preview' });
        const updatePreview = () => {
            const calculator = new WageCalculator(this.plugin.settings);
            const res = calculator.calculateShiftWage(dateInput.value, startInput.value, endInput.value, this.shift.isPaidLeave, this.shift.breakMinutes, storeSelect.value);
            renderWagePreview(preview, res.wageAmount, res.totalHours);
        };
        updatePreview();
        [dateInput, startInput, endInput].forEach(el => el.oninput = updatePreview);
        storeSelect.onchange = updatePreview;

        const foot = contentEl.createDiv({ cls: 'ap-modal-foot' });
        foot.createDiv({ cls: 'ap-foot-note', text: tr('Saving also updates the calendar event.', '保存时会同时更新日历事件。') });
        const cancelBtn = foot.createEl('button', { text: tr('Cancel', '取消') });
        cancelBtn.onClickEvent(() => this.close());
        const saveBtn = foot.createEl('button', { text: tr('Save', '保存'), cls: 'mod-cta' });
        saveBtn.onClickEvent(async () => {
            if (!this.plugin.ensureScheduleMutationAllowed()) return;
            this.shift.date = dateInput.value;
            this.shift.startTime = startInput.value;
            this.shift.endTime = endInput.value;
            this.shift.storeName = storeSelect.value;

            const calculator = new WageCalculator(this.plugin.settings);
            const res = calculator.calculateShiftWage(this.shift.date, this.shift.startTime, this.shift.endTime, this.shift.isPaidLeave, this.shift.breakMinutes, this.shift.storeName);
            this.shift.calculatedHours = res.totalHours;
            this.shift.calculatedWage = res.wageAmount;

            await this.plugin.saveDataStore();
            new Notice(tr('Shift updated.', '班次已更新。'));

            try {
                await this.plugin.syncShiftToCalendar(this.shift);
                new Notice(tr('Synced to calendar.', '已同步到日历。'));
            } catch (e) {
                new Notice(tr(`Calendar sync failed: ${errorMessage(e)}`, `日历同步失败：${errorMessage(e)}`));
            }

            this.close();
            this.onSave();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

function renderWagePreview(el: HTMLElement, wage: number, hours: number) {
    el.empty();
    const left = el.createDiv();
    left.createDiv({ cls: 'ap-cap', text: tr('Estimated wage', '预计工资') });
    left.createDiv({ cls: 'jws-preview-value ap-num', text: `¥${wage.toLocaleString()}` });
    const right = el.createDiv({ cls: 'jws-preview-right' });
    right.createDiv({ cls: 'ap-cap', text: tr('Hours', '工时') });
    right.createDiv({ cls: 'jws-preview-value ap-num', text: `${hours} h` });
}

class QuickAddShiftModal extends Modal {
    private date: string;
    private plugin: JapanWorkSecretaryPlugin;
    private onSave: () => void;
    private getShifts?: (start: Moment, end: Moment) => Shift[];

    constructor(app: App, date: string, plugin: JapanWorkSecretaryPlugin, onSave: () => void, getShifts?: (start: Moment, end: Moment) => Shift[]) {
        super(app);
        this.date = date;
        this.plugin = plugin;
        this.onSave = onSave;
        this.getShifts = getShifts;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        prepareModal(this, this.plugin, tr('Add shift', '加班次'));
        contentEl.createDiv({ cls: 'ap-modal-kicker', text: moment(this.date).format(tr('dddd, MMM D YYYY', 'YYYY年M月D日 dddd')) });

        const form = contentEl.createDiv({ cls: 'jws-form' });
        const timeRow = form.createDiv({ cls: 'jws-form-row' });
        const startInput = field(timeRow, tr('Start', '开始')).createEl('input', { attr: { type: 'time', value: '17:00' } });
        const endInput = field(timeRow, tr('End', '结束')).createEl('input', { attr: { type: 'time', value: '22:00' } });
        const storeSelect = field(form, tr('Store', '店铺')).createEl('select', { cls: 'dropdown' });
        normalizeStoreConfigs(this.plugin.settings.storeConfigs).forEach(store => {
            const opt = storeSelect.createEl('option', { text: store.name });
            opt.value = store.name;
        });
        const breakInput = field(form, tr('Break taken (minutes)', '休息（分钟）')).createEl('input', { attr: { type: 'number', min: '0', placeholder: tr('Not entered', '未填') } });
        const enteredBreak = () => (breakInput.value.trim() === '' ? undefined : Math.max(0, Number(breakInput.value) || 0));

        const preview = contentEl.createDiv({ cls: 'ap-card is-flat jws-preview' });
        const check = contentEl.createDiv({ cls: 'ap-notice jws-peak-check' });
        let saveBtn: HTMLButtonElement | null = null;

        // Show what this shift does to the busiest 7 days before it is saved.
        const updatePreview = () => {
            const calculator = new WageCalculator(this.plugin.settings);
            const res = calculator.calculateShiftWage(this.date, startInput.value, endInput.value, false, enteredBreak(), storeSelect.value);
            renderWagePreview(preview, res.wageAmount, res.totalHours);
            if (res.breakMissing) preview.createDiv({ cls: 'ap-cap jws-break-missing', text: breakMissingText(res.requiredBreakMinutes) });

            if (!this.getShifts) {
                check.hide();
                return;
            }
            const anchor = moment(this.date, 'YYYY-MM-DD');
            const tracker = new HoursTracker(parseVacationPeriods(this.plugin.settings.vacationPeriods || []));
            const existing = this.getShifts(anchor.clone().subtract(6, 'days'), anchor.clone().add(6, 'days'));
            const candidate = { id: 'candidate', date: this.date, startTime: startInput.value, endTime: endInput.value, storeName: storeSelect.value, calculatedHours: res.totalHours, calculatedWage: res.wageAmount } as Shift;
            const result = tracker.checkPeak7DayWindow([...existing, candidate], this.date);
            const range = `${moment(result.peakWindowStart).format('M/D')}–${moment(result.peakWindowEnd).format('M/D')}`;
            check.empty();
            check.removeClass('is-good', 'is-warn', 'is-danger');
            const text = check.createDiv();
            const vacationDay = tracker.isVacationDay(this.date);
            if (result.isOverLimit) {
                check.addClass('is-danger');
                text.createEl('strong', { text: tr(`This makes ${result.totalHoursLast7Days} h in ${range}.`, `这样 ${range} 共 ${result.totalHoursLast7Days} 小时。`) });
                text.appendText(tr(' That is over 28 h in 7 days. ', '这样 7 天内会超过 28 小时。'));
                if (result.mixesVacation) appendMixedWeekNote(text);
            } else if (vacationDay && res.totalHours > 8) {
                check.addClass('is-danger');
                text.appendText(tr(`Long-break day: ${res.totalHours} h is over 8 h.`, `长假日：${res.totalHours} 小时超过 8 小时。`));
            } else if (vacationDay && !result.mixesVacation) {
                check.addClass('is-good');
                text.appendText(tr('Long-break day: up to 8 h per day.', '长假日：每天最多 8 小时。'));
            } else {
                check.addClass(result.totalHoursLast7Days / 28 >= 0.85 ? 'is-warn' : 'is-good');
                text.appendText(tr(`Busiest 7 days with this shift: ${result.totalHoursLast7Days} h in ${range} (${result.remainingHours} h left). `, `加上这班，最忙的 7 天（${range}）共 ${result.totalHoursLast7Days} 小时，还剩 ${result.remainingHours} 小时。`));
                if (result.mixesVacation) appendMixedWeekNote(text);
            }
            saveBtn?.setText(result.isOverLimit ? tr('Save anyway', '仍然保存') : tr('Add shift', '加班次'));
        };

        const foot = contentEl.createDiv({ cls: 'ap-modal-foot' });
        foot.createDiv({ cls: 'ap-foot-note', text: tr('Also written to your calendar.', '也已写入日历。') });
        const cancelBtn = foot.createEl('button', { text: tr('Cancel', '取消') });
        cancelBtn.onClickEvent(() => this.close());
        saveBtn = foot.createEl('button', { text: tr('Add shift', '加班次'), cls: 'mod-cta' });
        updatePreview();
        [startInput, endInput, breakInput].forEach(el => el.oninput = updatePreview);
        storeSelect.onchange = updatePreview;

        saveBtn.onClickEvent(async () => {
            if (!this.plugin.ensureScheduleMutationAllowed()) return;
            const start = startInput.value;
            const end = endInput.value;

            const hasOverlap = this.plugin.shiftData.shifts.some((s: Shift) => {
                if (s.date !== this.date) return false;
                return (start < s.endTime) && (end > s.startTime);
            });

            if (hasOverlap) {
                 new Notice(tr('This overlaps an existing shift on the same day.', '和当天已有的班次时间重叠。'));
                 return;
            }

            const calculator = new WageCalculator(this.plugin.settings);
            const res = calculator.calculateShiftWage(this.date, start, end, false, enteredBreak(), storeSelect.value);

            const newShift = {
                breakMinutes: enteredBreak(),
                id: crypto.randomUUID(),
                date: this.date,
                startTime: start,
                endTime: end,
                storeName: storeSelect.value,
                calculatedHours: res.totalHours,
                calculatedWage: res.wageAmount,
                isPaidLeave: false,
                isSynced: false
            };

            this.plugin.shiftData.shifts.push(newShift);
            await this.plugin.saveDataStore();
            new Notice(tr('Shift added.', '已加班次。'));

            try {
                await this.plugin.syncShiftToCalendar(newShift);
                new Notice(tr('Synced to calendar.', '已同步到日历。'));
            } catch (e) {
                new Notice(tr(`Calendar sync failed: ${errorMessage(e)}`, `日历同步失败：${errorMessage(e)}`));
            }

            this.close();
            this.onSave();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}
