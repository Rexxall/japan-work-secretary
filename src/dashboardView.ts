import { ItemView, WorkspaceLeaf, Notice, Menu, requestUrl, Modal, App } from 'obsidian';
import JapanWorkSecretaryPlugin from './main';
import { HoursTracker, parseVacationPeriods } from './hoursTracker';
import { WageCalculator } from './wageCalculator';
import { HolidayUtility } from './holidayUtility';
import { ExchangeRateSnapshot, Shift, ShiftTemplatePattern, buildRecurringInstanceId, getStoreColorClass, getStoreShortName, getStoreWageBand, normalizeStoreConfigs, parseRecurringInstanceId } from './data';
import moment from 'moment';
import { PolicyExplanationModal } from './policyModal';

export const DASHBOARD_VIEW_TYPE = 'japan-work-dashboard-view';

interface RmbExchangeRateDisplay {
    rate: number;
    title: string;
}

export class DashboardView extends ItemView {
	plugin: JapanWorkSecretaryPlugin;
    viewMode: 'month' | 'week' = 'month';
    currentViewDate: moment.Moment = moment();
    selectedDate: moment.Moment = moment();
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
		return 'Work Secretary Dashboard';
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
        const rate = Number(response.json?.rates?.CNY);
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
        const rate = Number(response.json?.rate);
        if (!Number.isFinite(rate) || rate <= 0) return null;

        return {
            date: date || moment().format('YYYY-MM-DD'),
            rate,
            provider: 'Frankfurter',
            providerDate: typeof response.json?.date === 'string' ? response.json.date : date,
            fetchedAt: new Date().toISOString()
        };
    }

    private getPayrollPayDate(periodEnd: moment.Moment): moment.Moment {
        return periodEnd.clone().add(1, 'month').date(5).startOf('day');
    }

    private getRmbExchangeRateForPeriod(periodEnd: moment.Moment): RmbExchangeRateDisplay {
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

    private getPeriodForDate(date: moment.Moment): { start: moment.Moment, end: moment.Moment, label: string } {
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

    private getVisibleSyncPeriod(): { start: moment.Moment, end: moment.Moment, label: string } {
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

    private getPreviousPeriod(start: moment.Moment, end: moment.Moment): { start: moment.Moment, end: moment.Moment } {
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

    private getWorkMonthPeriod(date: moment.Moment): { start: moment.Moment, end: moment.Moment, label: string } {
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

    private getNextWorkMonthPeriod(date: moment.Moment): { start: moment.Moment, end: moment.Moment, label: string } {
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

    private async applyTemplateToWorkMonth(patterns: ShiftTemplatePattern[], period: { start: moment.Moment, end: moment.Moment }): Promise<number> {
        const start = period.start.format('YYYY-MM-DD');
        const end = period.end.format('YYYY-MM-DD');
        return this.createRecurringRulesFromPatterns(patterns, start, end);
    }

    private async saveTemplateFromRange(start: moment.Moment, end: moment.Moment, name: string): Promise<number> {
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
    getShiftsInRange(start: moment.Moment, end: moment.Moment) {
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
		const rootEl = this.contentEl.createDiv({ cls: 'japan-work-dashboard' });
		
        // --- Header Section ---
        const header = rootEl.createDiv({ cls: 'dashboard-header' });
        const titleGroup = header.createDiv({ attr: { style: 'display: flex; align-items: center; gap: 12px;' } });
        titleGroup.createEl('h2', { text: 'Secretary Dashboard 👩🏻‍💼', cls: 'dashboard-title' });

        // --- Dashboard Tab Header (Icons in Title Group) ---
        const tabHeader = titleGroup.createDiv({ cls: 'dashboard-tab-icons', attr: { style: 'display: flex; gap: 4px;' } });
        const tabs = [
            { id: 'calendar', name: '📅', title: 'Calendar & Analytics' },
            { id: 'management', name: '📋', title: 'Management' }
        ];

        tabs.forEach(t => {
            const btn = tabHeader.createEl('button', { 
                text: t.name, 
                cls: `view-toggle-btn ${this.activeDashboardTab === t.id ? 'active' : ''}`,
                attr: { title: t.title }
            });
            btn.onClickEvent(() => {
                this.activeDashboardTab = t.id as any;
                this.render();
            });
        });

        const controls = header.createDiv({ cls: 'header-controls' });

        // Navigation Group (Prev, Date, Next)
        const navGroup = controls.createDiv({ cls: 'nav-group' });
        const prevBtn = navGroup.createEl('button', { text: '<', cls: 'nav-btn' });
        const dateDisplay = navGroup.createEl('span', { text: this.viewMode === 'month' ? this.currentViewDate.format('YYYY-MM') : `Week of ${this.currentViewDate.startOf('isoWeek').format('MM-DD')}`, cls: 'date-display' });
        const nextBtn = navGroup.createEl('button', { text: '>', cls: 'nav-btn' });

        prevBtn.onClickEvent(() => {
            if (this.viewMode === 'month') this.currentViewDate.subtract(1, 'month');
            else this.currentViewDate.subtract(1, 'week');
            this.render();
        });
        nextBtn.onClickEvent(() => {
            if (this.viewMode === 'month') this.currentViewDate.add(1, 'month');
            else this.currentViewDate.add(1, 'week');
            this.render();
        });

        // View Toggles (Today, Month, Week)
        const viewToggle = controls.createDiv({ cls: 'view-toggle' });
        const todayBtn = viewToggle.createEl('button', { text: 'T', cls: 'today-btn', attr: { title: 'Today' } });
        const monthBtn = viewToggle.createEl('button', { text: 'M', cls: this.viewMode === 'month' ? 'active' : '', attr: { title: 'Month View' } });
        const weekBtn = viewToggle.createEl('button', { text: 'W', cls: this.viewMode === 'week' ? 'active' : '', attr: { title: 'Week View' } });
        
        todayBtn.onClickEvent(() => { 
            this.currentViewDate = moment(); 
            this.selectedDate = moment(); 
            this.render(); 
        });
        monthBtn.onClickEvent(() => { this.viewMode = 'month'; this.render(); });
        weekBtn.onClickEvent(() => { this.viewMode = 'week'; this.render(); });
        // Payroll Toggle
        const payrollToggle = controls.createEl('button', { 
            text: this.isPayrollView ? 'Payroll' : 'Natural', 
            cls: 'view-toggle-btn' 
        });
        payrollToggle.onClickEvent(() => {
            this.isPayrollView = !this.isPayrollView;
            this.render();
        });

        // Calendar sync modes
        const syncGroup = controls.createDiv({ cls: 'sync-mode-group' });
        const syncButtons: HTMLButtonElement[] = [];
        const runSync = async (action: () => Promise<unknown>) => {
            if (this.plugin.isCalendarSyncRunning()) {
                new Notice('Calendar sync is already running.');
                return;
            }
            syncButtons.forEach(button => button.disabled = true);
            try {
                await action();
            } finally {
                this.render();
            }
        };
        const smartSyncBtn = syncGroup.createEl('button', {
            text: 'Smart',
            cls: 'view-toggle-btn sync-primary-btn',
            attr: { title: 'Sync only new or changed shifts (default)' }
        });
        syncButtons.push(smartSyncBtn);
        smartSyncBtn.onClickEvent(() => void runSync(() => this.plugin.smartSyncCalendar()));

        const rangeSyncBtn = syncGroup.createEl('button', {
            text: 'Range',
            cls: 'view-toggle-btn',
            attr: { title: 'Smart sync the visible week, month, or payroll period' }
        });
        syncButtons.push(rangeSyncBtn);
        rangeSyncBtn.onClickEvent(() => void runSync(() => {
            const period = this.getVisibleSyncPeriod();
            return this.plugin.syncCalendarRange(
                period.start.format('YYYY-MM-DD'),
                period.end.format('YYYY-MM-DD'),
                period.label
            );
        }));

        const fullSyncBtn = syncGroup.createEl('button', {
            text: 'Full',
            cls: 'view-toggle-btn',
            attr: { title: 'Force reconciliation of all saved shifts plus the recurring-shift horizon' }
        });
        syncButtons.push(fullSyncBtn);
        fullSyncBtn.onClickEvent(() => void runSync(() => this.plugin.syncAllShifts()));

        const shareBtn = controls.createEl('button', {
            text: 'Share',
            cls: 'view-toggle-btn',
            attr: { title: 'Export this schedule as text or image' }
        });
        shareBtn.onClickEvent(() => {
            const period = this.getPeriodForDate(this.currentViewDate);
            new ShiftShareModal(
                this.app,
                period.start,
                period.end,
                (start, end) => this.getShiftsInRange(start, end),
                (shifts) => this.calculateTotalSum(shifts)
            ).open();
        });



        const contentWrapper = rootEl.createDiv({ cls: 'dashboard-content-wrapper' });



        // Calculate wage based on view mode
        const activePeriod = this.getPeriodForDate(this.currentViewDate);
        const displayMonthLabel = activePeriod.label;
        const calcStart = activePeriod.start;
        const calcEnd = activePeriod.end;
        const monthlyWage = this.getMonthlyWage(calcStart, calcEnd);

        if (this.activeDashboardTab === 'calendar') {
            const topStatsBar = contentWrapper.createDiv({ cls: 'top-stats-bar' });

            // 2. Monthly Wage Card (top bar)
            const wageCard = topStatsBar.createDiv({ cls: 'dashboard-card wage-card' });
            wageCard.createEl('h3', { text: 'Estimated Wage' });
            wageCard.createEl('h2', { text: `¥${monthlyWage.toLocaleString()}` });
            
            const rmbRate = this.getRmbExchangeRateForPeriod(calcEnd);
            const rmbWage = Math.floor(monthlyWage * rmbRate.rate);
            wageCard.createEl('p', { 
                text: `≈ ¥${rmbWage.toLocaleString()} RMB`, 
                cls: 'rmb-estimation',
                attr: { title: rmbRate.title }
            });

            // ➕ 计算并注入本月总工时
            const currentShifts = this.getShiftsInRange(calcStart, calcEnd);
            let monthTotalHours = 0;
            currentShifts.forEach(s => monthTotalHours += s.calculatedHours || 0);

            const hoursStat = wageCard.createDiv({ cls: 'wage-hours-stat', attr: { style: 'margin-top: 16px; border-top: 1px dashed var(--glass-border); padding-top: 12px; display: flex; align-items: center; gap: 8px;' } });
            hoursStat.createEl('span', { text: `🕒 ${monthTotalHours} Hours Worked`, attr: { style: 'font-weight: 600; font-size: 0.85rem; opacity: 0.85;' } });

            // 3. 28-Hour Tracker Card (top bar)
            const limitCard = topStatsBar.createDiv({ cls: 'dashboard-card' });
            const tracker = new HoursTracker(parseVacationPeriods(this.plugin.settings.vacationPeriods || []));
            const checkRangeStart = this.selectedDate.clone().subtract(6, 'days');
            const checkRangeEnd = this.selectedDate.clone().add(6, 'days');
            const shiftsForCheck = this.getShiftsInRange(checkRangeStart, checkRangeEnd);
            const limitResult = tracker.checkPeak7DayWindow(shiftsForCheck, this.selectedDate.format('YYYY-MM-DD'));
            const percent = Math.min(100, Math.round((limitResult.totalHoursLast7Days / 28) * 100));

            limitCard.createEl('h3', { text: 'Peak 7-Day' });
            const limitContainer = limitCard.createDiv({ cls: 'limit-tracker-container' });
            const circle = limitContainer.createDiv({ cls: 'progress-circle' });
            circle.style.setProperty('--progress-percent', percent.toString());
            circle.createEl('span', { text: `${percent}%` });

            const limitInfo = limitContainer.createDiv();
            limitInfo.createEl('h2', { text: `${limitResult.totalHoursLast7Days}h` });
            const peakRangeText = `${moment(limitResult.peakWindowStart).format('MM/DD')} - ${moment(limitResult.peakWindowEnd).format('MM/DD')}`;
            limitInfo.createEl('p', { text: peakRangeText, attr: { style: 'font-size: 0.75rem; opacity: 0.6; margin: 2px 0;' } });

            if (limitResult.isOverLimit) {
                limitInfo.createEl('p', { text: '⚠️ RISK DETECTED!', cls: 'warning-text' });
            } else {
                limitInfo.createEl('p', { text: `${limitResult.remainingHours}h safe buffer`, attr: { style: 'color: var(--text-success); font-weight: bold;' } });
            }

            const vacationOver = tracker.findVacationDaysOverLimit(shiftsForCheck);
            if (tracker.isVacationDay(this.selectedDate.format('YYYY-MM-DD'))) {
                limitInfo.createEl('p', { text: '长假期间：每天 8h 以内', cls: 'jws-vacation-note' });
            }
            if (vacationOver.length > 0) {
                limitInfo.createEl('p', {
                    text: `⚠️ 长假超 8h：${vacationOver.map(day => `${moment(day.date).format('MM/DD')} ${day.hours}h`).join('、')}`,
                    cls: 'warning-text'
                });
            }

            this.renderIncomeAnalyticsCard(topStatsBar, calcStart, calcEnd, displayMonthLabel, monthlyWage, currentShifts);

        // 1. Main View (Calendar or Week)
        const calendarSection = contentWrapper.createDiv({ cls: 'dashboard-section calendar-section' });
        if (this.viewMode === 'month') {
            this.renderCalendar(calendarSection);
        } else {
            this.renderWeekView(calendarSection);
        }

        // 2. Weekly Hours Chart Card (挪到下方)
        const bottomStatsBar = contentWrapper.createDiv({ cls: 'bottom-stats-bar', attr: { style: 'margin-top: 16px;' } });
        const chartCard = bottomStatsBar.createDiv({ cls: 'dashboard-card chart-card' });
        this.renderWeeklyChart(chartCard);

        } else {
            // 4. Summary Grid (Tax & Legal only)
        const summarySection = contentWrapper.createDiv({ cls: 'dashboard-section summary-section' });
		const grid = summarySection.createDiv({ cls: 'dashboard-grid summary-grid' });

        // Tax Strategy Card
        const yearStart = this.currentViewDate.clone().startOf('year');
        const yearEnd = this.currentViewDate.clone().endOf('year');
        this.annualWage = this.getAnnualWage(yearStart, yearEnd);
        this.renderTaxStrategyCard(grid, monthlyWage, this.annualWage);
        this.renderLegalStatusCard(grid);

        // 3. Management Section
        const mgmtSection = contentWrapper.createDiv({ cls: 'dashboard-section mgmt-section' });
        mgmtSection.createEl('h3', { text: 'Shift Management' });
        const mgmtGrid = mgmtSection.createDiv({ cls: 'dashboard-grid mgmt-grid' });
        
        // Left Card: Manual Entry & Existing Recurring Shifts
        const formCard = mgmtGrid.createDiv({ cls: 'dashboard-card' });
        this.renderLeftManagementColumn(formCard);

        // Right Card: Weekly Pattern Helper (Batch Add)
        const recurCard = mgmtGrid.createDiv({ cls: 'dashboard-card' });
        recurCard.createEl('h3', { text: '🗓️ Weekly Pattern Helper (Batch Add)' });
        this.renderRightManagementColumn(recurCard);
        }
	}

    private renderIncomeAnalyticsCard(
        container: HTMLElement,
        calcStart: moment.Moment,
        calcEnd: moment.Moment,
        displayLabel: string,
        monthlyWage: number,
        currentShifts: Shift[]
    ) {
        const card = container.createDiv({ cls: 'dashboard-card income-analytics-card' });
        card.createEl('h3', { text: 'Income Analytics' });

        const previousPeriod = this.getPreviousPeriod(calcStart, calcEnd);
        const previousWage = this.getMonthlyWage(previousPeriod.start, previousPeriod.end);
        const delta = monthlyWage - previousWage;
        const deltaLabel = `${delta >= 0 ? '+' : '-'}¥${Math.abs(delta).toLocaleString()}`;
        const percentLabel = previousWage > 0
            ? `${delta >= 0 ? '+' : ''}${Math.round((delta / previousWage) * 100)}%`
            : (monthlyWage > 0 ? 'New' : '0%');

        const comparison = card.createDiv({ cls: 'income-comparison' });
        const currentCol = comparison.createDiv();
        currentCol.createSpan({ text: displayLabel, cls: 'income-period-label' });
        currentCol.createDiv({ text: `¥${monthlyWage.toLocaleString()}`, cls: 'income-current-value' });

        const deltaCol = comparison.createDiv({ cls: `income-delta ${delta >= 0 ? 'positive' : 'negative'}` });
        deltaCol.createSpan({ text: 'vs previous' });
        deltaCol.createDiv({ text: `${deltaLabel} (${percentLabel})` });

        const trendRows: { label: string, wage: number }[] = [];
        for (let i = 5; i >= 0; i--) {
            const period = this.getPeriodForDate(this.currentViewDate.clone().subtract(i, 'month'));
            trendRows.push({
                label: this.isPayrollView ? period.start.format('M/D') : period.start.format('MMM'),
                wage: this.getMonthlyWage(period.start, period.end)
            });
        }

        const maxTrendWage = Math.max(1, ...trendRows.map(row => row.wage));
        const trendChart = card.createDiv({ cls: 'income-trend-chart' });
        trendRows.forEach(row => {
            const wrap = trendChart.createDiv({ cls: 'income-trend-bar-wrap' });
            const bar = wrap.createDiv({ cls: 'income-trend-bar' });
            bar.style.height = `${Math.max(4, Math.round((row.wage / maxTrendWage) * 100))}%`;
            bar.setAttribute('title', `${row.label}: ¥${row.wage.toLocaleString()}`);
            wrap.createDiv({ text: row.label, cls: 'income-trend-label' });
        });

        const storeTotals = new Map<string, number>();
        currentShifts.forEach(shift => {
            storeTotals.set(shift.storeName, (storeTotals.get(shift.storeName) || 0) + (shift.calculatedWage || 0));
        });
        const storeRows = Array.from(storeTotals.entries())
            .sort((a, b) => b[1] - a[1]);
        const storeTotal = storeRows.reduce((sum, [, wage]) => sum + wage, 0);
        const storeSection = card.createDiv({ cls: 'store-income-section' });

        if (storeRows.length === 0 || storeTotal === 0) {
            storeSection.createDiv({ text: 'No store income in this period', cls: 'text-muted store-empty-state' });
            return;
        }

        const palette = ['#0d9488', '#7c3aed', '#2563eb', '#f59e0b', '#ef4444', '#10b981'];
        const shareBar = storeSection.createDiv({ cls: 'store-share-bar' });
        storeRows.forEach(([storeName, wage], index) => {
            const segment = shareBar.createDiv({ cls: 'store-share-segment' });
            segment.style.background = palette[index % palette.length];
            segment.style.flexBasis = `${(wage / storeTotal) * 100}%`;
            segment.setAttribute('title', `${getStoreShortName(this.plugin.settings, storeName)}: ¥${wage.toLocaleString()}`);
        });

        const legend = storeSection.createDiv({ cls: 'store-pie-legend' });
        storeRows.forEach(([storeName, wage], index) => {
            const row = legend.createDiv({ cls: 'store-pie-row' });
            const swatch = row.createSpan({ cls: 'store-pie-swatch' });
            swatch.style.background = palette[index % palette.length];
            const percent = Math.round((wage / storeTotal) * 100);
            row.createSpan({ text: `${getStoreShortName(this.plugin.settings, storeName)} ${percent}%`, cls: 'store-pie-name' });
            row.createSpan({ text: `¥${wage.toLocaleString()}`, cls: 'store-pie-value' });
        });
    }

    renderCalendar(parent: HTMLElement) {
        const calendarGrid = parent.createDiv({ cls: 'calendar-grid' });
        const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        days.forEach(d => calendarGrid.createDiv({ cls: 'calendar-day-header', text: d }));

        const startOfMonth = this.currentViewDate.clone().startOf('month');
        const endOfMonth = this.currentViewDate.clone().endOf('month');
        const startOfGrid = startOfMonth.clone().startOf('isoWeek');
        const endOfGrid = endOfMonth.clone().endOf('isoWeek');

        const allShifts = this.getShiftsInRange(startOfGrid, endOfGrid);

        let curr = startOfGrid.clone();
        while (curr.isBefore(endOfGrid)) {
            const capturedDate = curr.clone();
            const dateStr = capturedDate.format('YYYY-MM-DD');
            const shiftsForDay = allShifts.filter(s => s.date === dateStr);

            const dayEl = calendarGrid.createDiv({ cls: 'calendar-day' });
            if (capturedDate.isSame(moment(), 'day')) dayEl.addClass('today');
            if (capturedDate.isSame(this.selectedDate, 'day')) dayEl.addClass('selected-date');
            if (capturedDate.month() !== this.currentViewDate.month()) dayEl.addClass('other-month');
            
            // 周末分色类 (Sat, Sun)
            if (capturedDate.isoWeekday() === 6) dayEl.addClass('saturday');
            if (capturedDate.isoWeekday() === 7) dayEl.addClass('sunday');
            if (shiftsForDay.length > 0) dayEl.addClass('has-shifts');

            dayEl.createDiv({ text: capturedDate.format('D'), cls: 'calendar-day-number' });
            
            const holidayName = HolidayUtility.getHolidayName(capturedDate.format('YYYY-MM-DD'));
            if (holidayName) {
                dayEl.addClass('is-holiday');
                dayEl.setAttribute('title', holidayName);
            }
            
            dayEl.onClickEvent(() => {
                this.selectedDate = capturedDate.clone();
                this.render();
            });

            // Double Click to Quick Add
            dayEl.addEventListener('dblclick', (e) => {
                const target = e.target as HTMLElement;
                if (target.closest('.shift-tag')) return; // 👈 拦截班次条点击
                
                e.stopPropagation();
                new QuickAddShiftModal(this.app, capturedDate.format('YYYY-MM-DD'), this.plugin, () => this.render()).open();
            });


            
            shiftsForDay.forEach(s => {
                const recurringParts = parseRecurringInstanceId(s.id);
                const isRecurring = recurringParts !== null;
                const storeClass = getStoreColorClass(this.plugin.settings, s.storeName);
                const storeShortName = getStoreShortName(this.plugin.settings, s.storeName);
                
                const shiftEl = dayEl.createDiv({ 
                    cls: `shift-tag ${isRecurring ? 'recurring' : ''} ${s.isPaidLeave ? 'paid-leave' : ''} ${storeClass}`, 
                    text: (s.isPaidLeave ? '有给休暇' : `${s.startTime} ${storeShortName}`) + (s.isSynced ? ' ✅' : '')
                });
                
                // Rich Interaction: Hover Details
                shiftEl.setAttribute('title', `${s.storeName}\n${s.startTime} - ${s.endTime}\nEst. Wage: ¥${s.calculatedWage}`);

                shiftEl.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.handleShiftContextMenu(e, s);
                });

                shiftEl.onClickEvent((e) => {
                    e.stopPropagation();
                    this.selectedDate = capturedDate.clone();
                    // ❌ 单击班次小条时，不要在本级触发 render() 重新拉取 DOM。
                    // 否则会打断连续点击，撕碎本班次的 dblclick 监听器，导致双击失灵。
                });

                // 🟢 纯粹、原生且绝不中断的 dblclick 监听！
                shiftEl.addEventListener('dblclick', async (e) => {
                    e.stopPropagation();
                    if (!this.plugin.ensureScheduleMutationAllowed()) return;
                    
                    const sId = s.id;
                    const recurringIdParts = parseRecurringInstanceId(sId);
                    if (recurringIdParts) {
                        // 1. 固定班次转换 Manual & Edit
                        const rsId = recurringIdParts.ruleId;
                        const rs = this.plugin.shiftData.recurringShifts.find(r => r.id === rsId);
                        if (rs) {
                            // 关键点：将该日期加入排除列表，防止重复显示
                            rs.exceptions = rs.exceptions || [];
                            if (!rs.exceptions.includes(dateStr)) {
                                rs.exceptions.push(dateStr);
                            }

                            const calculator = new WageCalculator(this.plugin.settings);
                            const res = calculator.calculateShiftWage(dateStr, rs.startTime, rs.endTime, false, undefined, rs.storeName);
                            const newShift: any = {
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
                        // 2. 普通班次编辑
                        const shift = this.plugin.shiftData.shifts.find(sh => sh.id === s.id);
                        if (shift) {
                            new EditShiftModal(this.plugin.app, shift, this.plugin, () => this.render()).open();
                        }
                    }
                });
            });

            curr.add(1, 'day');
        }
    }

    renderWeekView(parent: HTMLElement) {
        const weekGrid = parent.createDiv({ cls: 'calendar-grid week-grid-layout' });
        
        const startOfWeek = this.currentViewDate.clone().startOf('isoWeek');
        const endOfWeek = this.currentViewDate.clone().endOf('isoWeek');
        const shifts = this.getShiftsInRange(startOfWeek, endOfWeek);

        let curr = startOfWeek.clone();
        while (curr.isSameOrBefore(endOfWeek, 'day')) {
            const capturedDate = curr.clone();
            const dayName = capturedDate.format('ddd DD');
            weekGrid.createDiv({ cls: 'calendar-day-header', text: dayName, attr: { style: 'text-align: left; background: none; border-bottom: 1px solid var(--glass-border);' } });
            
            const cell = weekGrid.createDiv({ cls: 'calendar-day week-view-cell' });
            if (capturedDate.isSame(this.selectedDate, 'day')) cell.addClass('selected-date');
            
            cell.onClickEvent(() => {
                this.selectedDate = capturedDate.clone();
                this.render();
            });
            
            const dayShifts = shifts.filter(s => s.date === capturedDate.format('YYYY-MM-DD'));
            
            dayShifts.forEach(s => {
                const isRecurring = parseRecurringInstanceId(s.id) !== null;
                const shiftEl = cell.createDiv({ 
                    cls: `shift-tag ${isRecurring ? 'recurring' : ''} ${s.isPaidLeave ? 'paid-leave' : ''}`, 
                    text: s.isPaidLeave ? `Paid Leave (${s.storeName})` : `${s.startTime}-${s.endTime} (${s.storeName})`
                });
                shiftEl.setAttribute('title', `Est. Wage: ¥${s.calculatedWage}`);
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
        const manageCard = parent.createDiv({ cls: 'dashboard-card management-card', attr: { style: 'margin-top: 16px;' } });
        const header = manageCard.createDiv({ cls: 'collapsible-header', attr: { style: 'cursor: pointer; font-weight: bold; padding-bottom: 8px; border-bottom: 1px solid var(--glass-border); display: flex; align-items: center; justify-content: space-between;' } });
        header.createSpan({ text: '➕ Management & Input' });
        const icon = header.createSpan({ text: '▶', cls: 'toggle-icon' });

        const content = manageCard.createDiv({ cls: 'collapsible-content', attr: { style: 'display: none; padding-top: 12px;' } });

        header.onClickEvent(() => {
            const isHidden = content.style.display === 'none';
            content.style.display = isHidden ? 'block' : 'none';
            icon.setText(isHidden ? '▼' : '▶');
        });

        const form = content.createDiv({ cls: 'manual-input-form' });

        const dateGroup = form.createDiv({ cls: 'form-group' });
        dateGroup.createEl('label', { text: 'Date' });
        const dateInput = dateGroup.createEl('input', { attr: { type: 'date', value: moment().format('YYYY-MM-DD') } });

        const timeGrid = form.createDiv({ cls: 'time-input-grid' });
        
        const startGroup = timeGrid.createDiv({ cls: 'form-group' });
        startGroup.createEl('label', { text: 'Start' });
        const startInput = startGroup.createEl('input', { attr: { type: 'time', value: '17:00' } });

        const endGroup = timeGrid.createDiv({ cls: 'form-group' });
        endGroup.createEl('label', { text: 'End' });
        const endInput = endGroup.createEl('input', { attr: { type: 'time', value: '22:00' } });

        const storeGroup = form.createDiv({ cls: 'form-group' });
        storeGroup.createEl('label', { text: 'Store' });
        const storeSelect = storeGroup.createEl('select');
        this.populateStoreSelect(storeSelect);

        const breakGroup = form.createDiv({ cls: 'form-group' });
        breakGroup.createEl('label', { text: 'Break Minutes (Optional)' });
        const breakInput = breakGroup.createEl('input', { attr: { type: 'number', placeholder: 'Auto calculate' } });

        const btn = form.createEl('button', { cls: 'submit-btn', text: 'Add to Records' });
        btn.onClickEvent(async () => {
            if (!this.plugin.ensureScheduleMutationAllowed()) return;
            const date = dateInput.value;
            const start = startInput.value;
            const end = endInput.value;
            const store = storeSelect.value;
            const customBreak = breakInput.value ? Number(breakInput.value) : undefined;

            // Overlap Detection
            const hasOverlap = this.plugin.shiftData.shifts.some(s => {
                if (s.date !== date) return false;
                return (start < s.endTime) && (end > s.startTime);
            });

            if (hasOverlap) {
                new Notice('⚠️ Warning: Time overlap with an existing shift on this day!');
                return;
            }
            
            // Re-calc wage
            const calculator = new WageCalculator(this.plugin.settings);
            const res = calculator.calculateShiftWage(date, start, end, false, customBreak, store);
            
            const newShift: any = {
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
            new Notice('Shift Added!');
            
            try {
                await this.plugin.syncShiftToCalendar(newShift);
                new Notice('Synced to Calendar! 🎉');
            } catch (e) {
                new Notice(`Calendar sync failed: ${e.message}`);
            }

            this.render();
        });

        parent.createEl('hr', { attr: { style: 'margin: 24px 0;' } });
        parent.createEl('h3', { text: 'Recurring Shifts' });

        const list = parent.createDiv({ attr: { style: 'max-height: 250px; overflow-y: auto; margin-bottom: 12px;' } });
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

        if (this.plugin.shiftData.recurringShifts.length === 0) {
            list.createEl('p', { text: 'No recurring shifts set.', cls: 'text-muted' });
        }

        this.plugin.shiftData.recurringShifts.forEach(rs => {
            const isEditing = this.editingRecurringId === rs.id;
            const item = list.createDiv({ cls: 'recurring-item' + (isEditing ? ' editing' : '') });
            
            if (isEditing) {
                // Edit controls
                const editRow1 = item.createDiv({ cls: 'edit-recurring-row' });
                const daySel = editRow1.createEl('select');
                days.forEach((d, i) => { const opt = daySel.createEl('option', { text: d }); opt.value = i.toString(); if (i === rs.dayOfWeek) opt.selected = true; });
                const storeSel = editRow1.createEl('select');
                this.populateStoreSelect(storeSel, rs.storeName);

                const editRow2 = item.createDiv({ cls: 'edit-recurring-row mt-4' });
                const startIn = editRow2.createEl('input', { attr: { type: 'time', value: rs.startTime } });
                const endIn = editRow2.createEl('input', { attr: { type: 'time', value: rs.endTime } });

                const editRow3 = item.createDiv({ cls: 'edit-recurring-row mt-4' });
                const startDateIn = editRow3.createEl('input', { attr: { type: 'date', value: rs.startDate || '' } });
                const endDateIn = editRow3.createEl('input', { attr: { type: 'date', value: rs.endDate || '' } });

                const editActions = item.createDiv({ attr: { style: 'display: flex; gap: 8px; margin-top: 8px;' } });
                const saveBtn = editActions.createEl('button', { text: 'Save', cls: 'mod-cta', attr: { style: 'flex: 1; font-size: 0.7rem; padding: 4px;' } });
                const cancelBtn = editActions.createEl('button', { text: 'Cancel', attr: { style: 'flex: 1; font-size: 0.7rem; padding: 4px;' } });

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
                item.createEl('span', { text: `${days[rs.dayOfWeek]} ${rs.startTime}-${rs.endTime} @ ${getStoreShortName(this.plugin.settings, rs.storeName)}`, attr: { style: 'font-size: 0.8rem; flex: 1;' } });
                
                const actions = item.createDiv({ attr: { style: 'display: flex; gap: 4px;' } });
                const editIcon = actions.createEl('button', { text: '✎', attr: { style: 'background: none; border: none; cursor: pointer; opacity: 0.6;' } });
                const delBtn = actions.createEl('button', { text: '×', attr: { style: 'background: none; border: none; cursor: pointer; color: var(--text-error);' } });

                editIcon.onClickEvent(() => { this.editingRecurringId = rs.id; this.render(); });
                delBtn.onClickEvent(async () => {
                    if (!this.plugin.ensureScheduleMutationAllowed()) return;
                    if (confirm("Delete this recurring shift?")) {
                        this.plugin.shiftData.recurringShifts = this.plugin.shiftData.recurringShifts.filter(r => r.id !== rs.id);
                        await this.plugin.saveDataStore();
                        this.render();
                    }
                });
            }
        });
    }

    renderRightManagementColumn(parent: HTMLElement) {
        const addSection = parent.createDiv({ cls: 'add-recurring-section' });
        
        const gridWrapper = addSection.createDiv({ cls: 'weekly-pattern-grid' });
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        
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

        const seedTemplateBtn = batchControls.createEl('button', {
            text: 'Build Template from 2026-06-01 Week',
            cls: 'template-seed-btn'
        });
        seedTemplateBtn.onClickEvent(async () => {
            const count = await this.saveTemplateFromRange(
                moment('2026-06-01', 'YYYY-MM-DD'),
                moment('2026-06-07', 'YYYY-MM-DD'),
                '2026-06-01 weekly pattern'
            );
            new Notice(count > 0 ? `Saved 2026-06-01 weekly template (${count} shift pattern(s)).` : 'No shifts found for 2026-06-01 to 2026-06-07.');
            this.render();
        });

        const templateNameInput = batchControls.createEl('input', {
            attr: {
                type: 'text',
                value: this.templateName,
                placeholder: 'Template name',
                style: 'width: 100%; margin-bottom: 8px;'
            }
        });
        templateNameInput.oninput = () => this.templateName = templateNameInput.value || 'Regular weekly pattern';

        const storeSel = batchControls.createEl('select', { attr: { style: 'width: 100%; margin-bottom: 8px;' } });
        const selectedStore = this.weeklyPatternStoreName || this.getStoreOptions()[0]?.name;
        this.populateStoreSelect(storeSel, selectedStore);
        storeSel.onchange = () => this.weeklyPatternStoreName = storeSel.value;

        const dateRow = batchControls.createDiv({ cls: 'batch-date-row' });
        const startD = dateRow.createEl('input', { attr: { type: 'date', value: this.batchStartDate, placeholder: 'Start Date' } });
        const endD = dateRow.createEl('input', { attr: { type: 'date', value: this.batchEndDate, placeholder: 'End Date' } });
        
        startD.onchange = () => this.batchStartDate = startD.value;
        endD.onchange = () => this.batchEndDate = endD.value;

        const actionRow = batchControls.createDiv({ cls: 'template-action-row' });
        const saveTemplateBtn = actionRow.createEl('button', { text: 'Save Template', cls: 'submit-btn' });
        const addBtn = actionRow.createEl('button', { text: 'Create Rules', cls: 'submit-btn' });

        saveTemplateBtn.onClickEvent(async () => {
            const patterns = this.getActiveTemplatePatterns(storeSel.value);
            if (patterns.length === 0) {
                new Notice('Please select at least one day.');
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
            new Notice(`Saved template with ${patterns.length} day(s).`);
            this.render();
        });

        addBtn.onClickEvent(async () => {
            const patterns = this.getActiveTemplatePatterns(storeSel.value);
            if (patterns.length === 0) {
                new Notice('Please select at least one day.');
                return;
            }

            const added = await this.createRecurringRulesFromPatterns(patterns, this.batchStartDate, this.batchEndDate);
            if (added < 0) return;
            new Notice(added > 0 ? `Added ${added} recurring rule(s).` : 'No new rules added; matching rules already exist.');
            this.render();
        });

        const templates = this.plugin.shiftData.shiftTemplates || [];
        const templateList = addSection.createDiv({ cls: 'template-list' });
        templateList.createEl('h4', { text: 'Saved Templates' });

        if (templates.length === 0) {
            templateList.createEl('p', { text: 'No templates saved yet.', cls: 'text-muted' });
            return;
        }

        templates.forEach(template => {
            const row = templateList.createDiv({ cls: 'template-item' });
            const info = row.createDiv({ cls: 'template-item-info' });
            info.createDiv({ text: template.name, cls: 'template-item-title' });
            const summary = template.patterns
                .map(pattern => `${days[pattern.dayOfWeek]} ${pattern.startTime}-${pattern.endTime} ${getStoreShortName(this.plugin.settings, pattern.storeName)}`)
                .join(' / ');
            info.createDiv({ text: summary, cls: 'template-item-summary' });

            const actions = row.createDiv({ cls: 'template-item-actions' });
            const loadBtn = actions.createEl('button', { text: 'Load' });
            const applyBtn = actions.createEl('button', { text: 'Range' });
            const thisMonthBtn = actions.createEl('button', { text: 'This Work Month' });
            const nextMonthBtn = actions.createEl('button', { text: 'Next Work Month' });
            const deleteBtn = actions.createEl('button', { text: '×', cls: 'template-delete-btn' });

            loadBtn.onClickEvent(() => {
                this.templateName = template.name;
                this.loadTemplateIntoEditor(template.patterns);
                this.render();
            });

            applyBtn.onClickEvent(async () => {
                const added = await this.createRecurringRulesFromPatterns(template.patterns, this.batchStartDate, this.batchEndDate);
                if (added < 0) return;
                new Notice(added > 0 ? `Applied template: ${added} recurring rule(s).` : 'No new rules added; matching rules already exist.');
                this.render();
            });

            thisMonthBtn.onClickEvent(async () => {
                const period = this.getWorkMonthPeriod(this.currentViewDate);
                const added = await this.applyTemplateToWorkMonth(template.patterns, period);
                if (added < 0) return;
                new Notice(added > 0 ? `Scheduled ${period.label} with ${added} recurring rule(s).` : `${period.label} already has matching rules.`);
                this.currentViewDate = period.start.clone();
                this.selectedDate = period.start.clone();
                this.activeDashboardTab = 'calendar';
                this.render();
            });

            nextMonthBtn.onClickEvent(async () => {
                const period = this.getNextWorkMonthPeriod(this.currentViewDate);
                const added = await this.applyTemplateToWorkMonth(template.patterns, period);
                if (added < 0) return;
                new Notice(added > 0 ? `Scheduled ${period.label} with ${added} recurring rule(s).` : `${period.label} already has matching rules.`);
                this.currentViewDate = period.start.clone();
                this.selectedDate = period.start.clone();
                this.activeDashboardTab = 'calendar';
                this.render();
            });

            deleteBtn.onClickEvent(async () => {
                if (!confirm(`Delete template "${template.name}"?`)) return;
                this.plugin.shiftData.shiftTemplates = templates.filter(t => t.id !== template.id);
                await this.plugin.saveDataStore();
                this.render();
            });
        });
    }

    private handleShiftContextMenu(e: MouseEvent, s: any) {
        const menu = new Menu();
        const recurringParts = parseRecurringInstanceId(s.id);
        const isRecurring = recurringParts !== null;

        if (isRecurring) {
            menu.addItem((item) => {
                item.setTitle('Convert instance to Manual & Edit')
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
                            const newShift: any = {
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
                item.setTitle('Delete this occurrence only')
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
                            new Notice(`Deleted only ${moment(s.date).format('MM/DD')} occurrence.`);
                        }
                        this.render();
                    });
            });
            menu.addItem((item) => {
                item.setTitle('Delete entire Recurring Rule')
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
                item.setTitle('Edit Shift')
                    .setIcon('pencil')
                    .onClick(() => {
                        const shift = this.plugin.shiftData.shifts.find(sh => sh.id === s.id);
                        if (shift) {
                            new EditShiftModal(this.plugin.app, shift, this.plugin, () => this.render()).open();
                        }
                    });
            });
            menu.addItem((item) => {
                item.setTitle(s.isPaidLeave ? 'Unmark Paid Leave' : 'Mark as Paid Leave')
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
                item.setTitle('Delete Shift')
                    .setIcon('trash')
                    .onClick(async () => {
                        if (!this.plugin.ensureScheduleMutationAllowed()) return;
                        const shift = this.plugin.shiftData.shifts.find(sh => sh.id === s.id);
                        if (shift && this.plugin.hasShiftCalendarRecord(shift.id)) {
                            try {
                                await this.plugin.deleteShiftFromCalendar(shift);
                            } catch (error) {
                                console.error('Calendar delete failed.', error);
                                new Notice('Calendar delete failed; local shift was still removed.');
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

    private getMonthlyWage(start: moment.Moment, end: moment.Moment): number {
        const shifts = this.getShiftsInRange(start, end);
        return this.calculateTotalSum(shifts);
    }

    private getAnnualWage(start: moment.Moment, end: moment.Moment): number {
        const allShifts = this.getShiftsInRange(start, end);
        return this.calculateTotalSum(allShifts);
    }

    private calculateTotalSum(shifts: any[]): number {
        const dayGroups: { [key: string]: any[] } = {};
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
        const card = container.createDiv({ cls: 'dashboard-card tax-strategy-card' });
        const headerRow = card.createDiv({ attr: { style: 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;' } });
        headerRow.createEl('h3', { text: 'Income Alerts', attr: { style: 'margin-bottom: 0;' } });
        const infoBtn = headerRow.createEl('button', { text: 'ℹ️ 政策', cls: 'policy-info-btn', attr: { style: 'background: rgba(255,255,255,0.05); border: 1px solid var(--glass-border); font-size: 0.75rem; padding: 3px 8px; border-radius: 4px; cursor: pointer;' } });
        infoBtn.onClickEvent(() => {
            new PolicyExplanationModal(this.plugin.app).open();
        });
        
        const list = card.createDiv({ cls: 'tax-alert-list' });

        const alerts = (this.plugin.settings.incomeAlerts || []).filter(alert => alert.enabled && alert.amount > 0);
        if (alerts.length === 0) {
            list.createEl('p', {
                text: '未开启收入提醒线。可在设置 → 收入提醒线 里按当年规定填写。',
                cls: 'tax-desc'
            });
        }
        for (const alert of alerts) {
            const current = alert.period === 'annual' ? annual : monthly;
            const status = this.getWallStatus(current, alert.amount);
            this.createTaxItem(list, alert.label, current, alert.amount, status);
        }
    }

    private getWallStatus(current: number, wall: number): 'safe' | 'near' | 'danger' {
        const ratio = current / wall;
        if (ratio > 1) return 'danger';
        if (ratio > 0.85) return 'near';
        return 'safe';
    }

    private createTaxItem(container: HTMLElement, label: string, current: number, wall: number, status: 'safe' | 'near' | 'danger') {
        const item = container.createDiv({ cls: `tax-item ${status}` });
        const top = item.createDiv({ cls: 'tax-item-top' });
        top.createEl('span', { text: label, cls: 'tax-label' });
        
        let icon = '✅';
        if (status === 'near') icon = '⚠️';
        if (status === 'danger') icon = '🚨';
        top.createEl('span', { text: icon });

        const barContainer = item.createDiv({ cls: 'tax-bar-container' });
        const percent = Math.min(100, Math.round((current / wall) * 100));
        const bar = barContainer.createDiv({ cls: 'tax-bar' });
        bar.style.width = `${percent}%`;

        const desc = item.createEl('p', { 
            text: `${current.toLocaleString()} / ${wall.toLocaleString()} JPY (${percent}%)`,
            cls: 'tax-desc'
        });
    }

    private renderLegalStatusCard(containerEl: HTMLElement) {
        const card = containerEl.createDiv({ cls: 'dashboard-card legal-status-card' });
        card.createEl('h3', { text: 'Legal & Paid Leave ⚖️' });
        
        const statsList = card.createDiv({ cls: 'legal-stats-list' });
        
        // Paid Leave Balance
        const leaveBalance = this.plugin.settings.paidLeaveBalance || 0;
        const usedLeave = this.plugin.shiftData.shifts.filter(s => s.isPaidLeave).length;
        const remainingLeave = leaveBalance - usedLeave;
        
        const leaveItem = statsList.createDiv({ cls: 'legal-item' });
        leaveItem.createDiv({ cls: 'legal-label', text: 'Paid Leave Balance (有给休暇)' });
        leaveItem.createDiv({ cls: 'legal-value', text: `${remainingLeave} / ${leaveBalance} days` });
        
        const barContainer = leaveItem.createDiv({ cls: 'tax-bar-container' });
        const bar = barContainer.createDiv({ cls: 'tax-bar' });
        const leavePercent = leaveBalance > 0 ? (remainingLeave / leaveBalance) * 100 : 0;
        bar.style.width = `${leavePercent}%`;
        if (remainingLeave <= 1) bar.style.background = '#dc3545';

        // Weekly Overtime Warning (Current Week)
        const startOfWeek = moment().startOf('week');
        const endOfWeek = moment().endOf('week');
        const weekShifts = this.getShiftsInRange(startOfWeek, endOfWeek);
        
        const totalHours = weekShifts.reduce((sum, s) => sum + s.calculatedHours, 0);
        const otItem = statsList.createDiv({ cls: 'legal-item' });
        otItem.createDiv({ cls: 'legal-label', text: 'Weekly Hours (current)' });
        otItem.createDiv({ cls: 'legal-value', text: `${totalHours.toFixed(1)} / 40h` });
        
        const otBarContainer = otItem.createDiv({ cls: 'tax-bar-container' });
        const otBar = otBarContainer.createDiv({ cls: 'tax-bar' });
        const otPercent = Math.min(100, (totalHours / 40) * 100);
        otBar.style.width = `${otPercent}%`;
        
        if (totalHours > 40) {
            otItem.addClass('danger');
            otBar.style.background = '#dc3545';
            otItem.createEl('p', { cls: 'legal-warning', text: '⚠️ weekly overtime detected (+25% premium)' });
        }
    }

    private renderWeeklyChart(parent: HTMLElement) {
        parent.createEl('h3', { text: 'Weekly Hours (Last 7 Days)', attr: { style: 'margin-bottom: 8px;' } });
        const chartContainer = parent.createDiv({ attr: { style: 'display: flex; align-items: flex-end; gap: 8px; height: 60px; padding-top: 10px;' } });

        const days = [];
        for (let i = 6; i >= 0; i--) {
            days.push(moment().subtract(i, 'days'));
        }

        const maxHours = 8;
        days.forEach(d => {
            const dateStr = d.format('YYYY-MM-DD');
            const dayShifts = this.getShiftsInRange(d, d);
            const totalHours = dayShifts.reduce((sum, s) => sum + s.calculatedHours, 0);
            const heightPercent = Math.min(100, (totalHours / maxHours) * 100);

            const barWrapper = chartContainer.createDiv({ attr: { style: 'flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 4px; height: 100%;' } });
            
            const bar = barWrapper.createDiv({ cls: 'chart-bar' });
            bar.style.height = `${heightPercent}%`;
            bar.style.width = '100%';
            bar.style.background = totalHours > 0 ? 'var(--accent-gradient)' : 'rgba(255,255,255,0.08)';
            bar.style.borderRadius = '4px';
            bar.style.minHeight = '1px';
            bar.setAttribute('title', `${totalHours}h on ${d.format('MM/DD')}`);

            barWrapper.createDiv({ text: d.format('dd'), attr: { style: 'font-size: 0.6rem; opacity: 0.5;' } });
        });
    }
}

class ShiftShareModal extends Modal {
    private start: moment.Moment;
    private end: moment.Moment;
    private getShifts: (start: moment.Moment, end: moment.Moment) => any[];
    private calculateTotal: (shifts: any[]) => number;

    constructor(
        app: App,
        start: moment.Moment,
        end: moment.Moment,
        getShifts: (start: moment.Moment, end: moment.Moment) => any[],
        calculateTotal: (shifts: any[]) => number
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
        contentEl.addClass('shift-share-modal');

        contentEl.createEl('h2', { text: 'Share Schedule', cls: 'modal-title' });

        const form = contentEl.createDiv({ cls: 'share-range-row' });
        const startGroup = form.createDiv({ cls: 'form-group' });
        startGroup.createEl('label', { text: 'Start Date' });
        const startInput = startGroup.createEl('input', { attr: { type: 'date', value: this.start.format('YYYY-MM-DD') } });

        const endGroup = form.createDiv({ cls: 'form-group' });
        endGroup.createEl('label', { text: 'End Date' });
        const endInput = endGroup.createEl('input', { attr: { type: 'date', value: this.end.format('YYYY-MM-DD') } });

        const preview = contentEl.createEl('textarea', { cls: 'share-preview' });
        preview.readOnly = true;

        const updatePreview = () => {
            const start = moment(startInput.value, 'YYYY-MM-DD');
            const end = moment(endInput.value, 'YYYY-MM-DD');
            preview.value = this.buildShareText(start, end);
        };

        startInput.onchange = updatePreview;
        endInput.onchange = updatePreview;
        updatePreview();

        const actions = contentEl.createDiv({ cls: 'share-action-row' });
        const copyBtn = actions.createEl('button', { text: 'Copy Text', cls: 'submit-btn' });
        const imageBtn = actions.createEl('button', { text: 'Download PNG', cls: 'submit-btn' });
        const closeBtn = actions.createEl('button', { text: 'Close', cls: 'cancel-btn' });

        copyBtn.onClickEvent(async () => {
            await this.copyText(preview.value);
            new Notice('Schedule text copied.');
        });

        imageBtn.onClickEvent(async () => {
            const start = moment(startInput.value, 'YYYY-MM-DD');
            const end = moment(endInput.value, 'YYYY-MM-DD');
            await this.downloadImage(this.buildShareText(start, end), start, end);
        });

        closeBtn.onClickEvent(() => this.close());
    }

    private buildShareText(start: moment.Moment, end: moment.Moment): string {
        if (!start.isValid() || !end.isValid()) {
            return 'Invalid date range.';
        }

        if (end.isBefore(start, 'day')) {
            return 'End date must be after start date.';
        }

        const shifts = this.getShifts(start, end);
        const totalHours = shifts.reduce((sum, shift) => sum + (shift.calculatedHours || 0), 0);
        const totalWage = this.calculateTotal(shifts);
        const lines = [
            `排班 ${start.format('YYYY/MM/DD')} - ${end.format('YYYY/MM/DD')}`,
            `总工时 ${Math.round(totalHours * 10) / 10}h / 预估工资 ¥${totalWage.toLocaleString()}`,
            ''
        ];

        if (shifts.length === 0) {
            lines.push('暂无排班');
            return lines.join('\n');
        }

        const grouped: { [date: string]: any[] } = {};
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
                        ? `有给休暇 ${shift.storeName}`
                        : `${shift.startTime}-${shift.endTime} ${shift.storeName}`;
                    lines.push(`  ${label} (${shift.calculatedHours}h / ¥${Number(shift.calculatedWage || 0).toLocaleString()})`);
                });
        });

        return lines.join('\n');
    }

    private async copyText(text: string) {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }

        const temp = document.body.createEl('textarea');
        temp.value = text;
        temp.style.position = 'fixed';
        temp.style.opacity = '0';
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        temp.remove();
    }

    private async downloadImage(text: string, start: moment.Moment, end: moment.Moment) {
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
            new Notice('Schedule image exported.');
        } catch (error) {
            console.error('PNG export failed; falling back to SVG.', error);
            this.downloadBlob(svgBlob, `${fileStem}.svg`);
            new Notice('PNG export failed; SVG image exported instead.');
        }
    }

    private svgBlobToPng(svgBlob: Blob, width: number, height: number): Promise<Blob> {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(svgBlob);
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
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
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
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

// ─── Edit Shift Modal ─────────────────────────────────────────────────────────
class EditShiftModal extends Modal {
    private shift: any;
    private plugin: any;
    private onSave: () => void;

    constructor(app: App, shift: any, plugin: any, onSave: () => void) {
        super(app);
        this.shift = shift;
        this.plugin = plugin;
        this.onSave = onSave;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('edit-shift-modal');

        contentEl.createEl('h2', { text: '✏️ Edit Shift', cls: 'modal-title' });

        const form = contentEl.createDiv({ cls: 'edit-shift-form' });

        // Date
        const dateGroup = form.createDiv({ cls: 'form-group' });
        dateGroup.createEl('label', { text: 'Date' });
        const dateInput = dateGroup.createEl('input', { attr: { type: 'date', value: this.shift.date } });

        // Start / End time row
        const timeRow = form.createDiv({ cls: 'edit-shift-time-row' });
        const startGroup = timeRow.createDiv({ cls: 'form-group' });
        startGroup.createEl('label', { text: 'Start Time' });
        const startInput = startGroup.createEl('input', { attr: { type: 'time', value: this.shift.startTime } });

        const endGroup = timeRow.createDiv({ cls: 'form-group' });
        endGroup.createEl('label', { text: 'End Time' });
        const endInput = endGroup.createEl('input', { attr: { type: 'time', value: this.shift.endTime } });

        // Store
        const storeGroup = form.createDiv({ cls: 'form-group' });
        storeGroup.createEl('label', { text: 'Store' });
        const storeSelect = storeGroup.createEl('select');
        normalizeStoreConfigs(this.plugin.settings.storeConfigs).forEach(store => {
            const opt = storeSelect.createEl('option', { text: store.name });
            opt.value = store.name;
            if (store.name === this.shift.storeName) opt.selected = true;
        });

        // Live wage preview
        const previewEl = form.createDiv({ cls: 'edit-shift-preview' });

        const updatePreview = () => {
            const calculator = new WageCalculator(this.plugin.settings);
            const res = calculator.calculateShiftWage(dateInput.value, startInput.value, endInput.value, this.shift.isPaidLeave, this.shift.breakMinutes, storeSelect.value);
            previewEl.setText(`Estimated Wage: ¥${res.wageAmount.toLocaleString()}  (${res.totalHours}h)`);
        };
        updatePreview();
        [dateInput, startInput, endInput].forEach(el => el.oninput = updatePreview);

        // Buttons
        const btnRow = form.createDiv({ cls: 'edit-shift-btn-row' });

        const saveBtn = btnRow.createEl('button', { text: 'Save', cls: 'submit-btn' });
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
            new Notice('Shift updated!');
            
            try {
                await this.plugin.syncShiftToCalendar(this.shift);
                new Notice('Synced to Calendar! 🎉');
            } catch (e) {
                new Notice(`Calendar sync failed: ${e.message}`);
            }

            this.close();
            this.onSave();
        });

        const cancelBtn = btnRow.createEl('button', { text: 'Cancel', cls: 'cancel-btn' });
        cancelBtn.onClickEvent(() => this.close());
    }

    onClose() {
        this.contentEl.empty();
    }
}

class QuickAddShiftModal extends Modal {
    private date: string;
    private plugin: any;
    private onSave: () => void;

    constructor(app: App, date: string, plugin: any, onSave: () => void) {
        super(app);
        this.date = date;
        this.plugin = plugin;
        this.onSave = onSave;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('edit-shift-modal');

        contentEl.createEl('h2', { text: `➕ Quick Add Shift (${this.date})`, cls: 'modal-title' });

        const form = contentEl.createDiv({ cls: 'edit-shift-form' });

        const timeRow = form.createDiv({ cls: 'edit-shift-time-row' });
        const startGroup = timeRow.createDiv({ cls: 'form-group' });
        startGroup.createEl('label', { text: 'Start Time' });
        const startInput = startGroup.createEl('input', { attr: { type: 'time', value: '17:00' } });

        const endGroup = timeRow.createDiv({ cls: 'form-group' });
        endGroup.createEl('label', { text: 'End Time' });
        const endInput = endGroup.createEl('input', { attr: { type: 'time', value: '22:00' } });

        const storeGroup = form.createDiv({ cls: 'form-group' });
        storeGroup.createEl('label', { text: 'Store' });
        const storeSelect = storeGroup.createEl('select');
        normalizeStoreConfigs(this.plugin.settings.storeConfigs).forEach(store => {
            const opt = storeSelect.createEl('option', { text: store.name });
            opt.value = store.name;
        });

        const previewEl = form.createDiv({ cls: 'edit-shift-preview' });

        const updatePreview = () => {
            const calculator = new WageCalculator(this.plugin.settings);
            const res = calculator.calculateShiftWage(this.date, startInput.value, endInput.value, false, undefined, storeSelect.value);
            previewEl.setText(`Estimated Wage: ¥${res.wageAmount.toLocaleString()}  (${res.totalHours}h)`);
        };
        updatePreview();
        [startInput, endInput].forEach(el => el.oninput = updatePreview);

        const btnRow = form.createDiv({ cls: 'edit-shift-btn-row' });

        const saveBtn = btnRow.createEl('button', { text: 'Add to Records', cls: 'submit-btn' });
        saveBtn.onClickEvent(async () => {
            if (!this.plugin.ensureScheduleMutationAllowed()) return;
            const start = startInput.value;
            const end = endInput.value;

            const hasOverlap = this.plugin.shiftData.shifts.some((s: any) => {
                if (s.date !== this.date) return false;
                return (start < s.endTime) && (end > s.startTime);
            });

            if (hasOverlap) {
                 new Notice('⚠️ Time overlap with an existing shift on this day!');
                 return;
            }

            const calculator = new WageCalculator(this.plugin.settings);
            const res = calculator.calculateShiftWage(this.date, start, end, false, undefined, storeSelect.value);

            const newShift = {
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
            new Notice('Shift added!');

            try {
                await this.plugin.syncShiftToCalendar(newShift);
                new Notice('Synced to Calendar! 🎉');
            } catch (e) {
                new Notice(`Calendar sync failed: ${e.message}`);
            }

            this.close();
            this.onSave();
        });

        const cancelBtn = btnRow.createEl('button', { text: 'Cancel', cls: 'cancel-btn' });
        cancelBtn.onClickEvent(() => this.close());
    }

    onClose() {
        this.contentEl.empty();
    }
}
