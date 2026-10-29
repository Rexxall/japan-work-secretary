import { Plugin, Notice, Editor, TFile, arrayBufferToBase64, normalizePath, requestUrl, moment } from 'obsidian';
import { tr } from './i18n';
import { JapanWorkSecretarySettingTab, DEFAULT_SETTINGS, JapanWorkSecretarySettings, migrateIncomeAlerts } from './settings';
import { JapanWorkSecretaryData, DEFAULT_DATA, RecurringShift, Shift, normalizeStoreConfigs, parseRecurringInstanceId } from './data';
import { DashboardView, DASHBOARD_VIEW_TYPE } from './dashboardView';
import { AIParser, ParsedShiftDraft, draftToShift } from './aiParser';
import { ShiftReviewModal } from './reviewModal';
import { buildPayNote, buildShiftsIcs } from './exportShifts';
import { WageCalculator } from './wageCalculator';
import { CalendarSyncAction, MacCalendarSync } from './macCalendarSync';
import {
    CalendarSyncMode,
    buildCalendarSyncFingerprint,
    buildCalendarSyncStateKey,
    collectCalendarSyncShifts,
    createRecurringCalendarShift,
    findCalendarSyncOrphans,
    getCalendarSyncRecord,
    invalidateCalendarSyncRecord,
    planCalendarSync
} from './calendarSyncPlanner';
import { HolidayUtility } from './holidayUtility';
import { SecureSecretStore } from './secureSecretStore';

export interface JapanWorkSecretaryPluginData {
    settings: JapanWorkSecretarySettings;
    data: JapanWorkSecretaryData;
}

export interface CalendarSyncSummary {
    created: number;
    updated: number;
    deleted: number;
    skipped: number;
    failed: number;
    total: number;
}

interface CalendarSyncOptions {
    mode: CalendarSyncMode;
    startDate?: string;
    endDate?: string;
    label?: string;
}

const SHARED_GEMINI_SECRET = 'gemini-api-key';
const PLUGIN_GEMINI_SECRET = 'japan-work-secretary-gemini-api-key';

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', heic: 'image/heic' };

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export default class JapanWorkSecretaryPlugin extends Plugin {
	settings: JapanWorkSecretarySettings;
    shiftData: JapanWorkSecretaryData;
    private readonly holidayCacheTtlMs = 7 * 24 * 60 * 60 * 1000;
    private calendarSyncInProgress: boolean = false;

	async onload() {
		await this.loadDataStore();
        await this.initializeGeminiApiKey();
        this.refreshHolidayCache().catch(error => {
            console.warn('Failed to refresh Japanese holiday cache.', error);
        });

		// Add Settings Tab
		this.addSettingTab(new JapanWorkSecretarySettingTab(this.app, this));

        // Register Dashboard View
		this.registerView(
			DASHBOARD_VIEW_TYPE,
			(leaf) => new DashboardView(leaf, this)
		);

        // Command: Parse Shift from Selection
        this.addCommand({
            id: 'parse-shift-text-selection',
            name: tr('Read shifts from selected text', '从选中的文字读取班次'),
            editorCallback: (editor: Editor) => {
                const selection = editor.getSelection();
                if (!selection) {
                    new Notice(tr('Select the text that contains your shifts first.', '请先选中含有班次的文字。'));
                    return;
                }
                void this.parseShiftSelection(selection);
            }
        });

        this.addCommand({
            id: 'parse-shift-image',
            name: tr('Read shifts from images in the current note', '从当前笔记的图片读取班次'),
            callback: () => void this.parseShiftImage()
        });

        this.addCommand({
            id: 'open-dashboard',
            name: tr('Open dashboard', '打开面板'),
            callback: () => void this.openDashboard()
        });

        this.addCommand({
            id: 'sync-smart-to-calendar',
            name: tr('Sync changed shifts to macOS Calendar', '把改动的班次同步到 macOS 日历'),
            callback: () => void this.smartSyncCalendar()
        });

        this.addCommand({
            id: 'sync-all-to-calendar',
            name: tr('Rewrite all shifts in macOS Calendar', '在 macOS 日历里重写全部班次'),
            callback: () => void this.syncAllShifts()
        });

        this.addCommand({
            id: 'refresh-japanese-holidays',
            name: tr('Refresh Japanese holiday cache', '刷新日本假日缓存'),
            callback: async () => {
                await this.refreshHolidayCache(true);
                new Notice(tr('Japanese holiday cache refreshed.', '已刷新日本假日缓存。'));
            }
        });

	}

	async loadDataStore() {
        // Load data, handling cases where it might be empty or missing properties
		const loadedData = (await this.loadData()) as Partial<JapanWorkSecretaryPluginData> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData?.settings);
        this.settings.storeConfigs = normalizeStoreConfigs(this.settings.storeConfigs);
        // Read the saved settings, not the merged ones: the defaults already carry a list of alerts,
        // which would hide the on/off switches saved by 1.1.x.
        this.settings.incomeAlerts = migrateIncomeAlerts(loadedData?.settings ?? {});
        delete this.settings.taxWall88k;
        delete this.settings.taxWall103k;
        delete this.settings.taxWall130k;
        if (!Array.isArray(this.settings.vacationPeriods)) this.settings.vacationPeriods = [];
        if (typeof this.settings.eventTitlePrefix !== 'string') this.settings.eventTitlePrefix = DEFAULT_SETTINGS.eventTitlePrefix;
        this.settings.holidayCache = this.settings.holidayCache || {};
        this.settings.holidayCacheUpdatedAt = this.settings.holidayCacheUpdatedAt || 0;
        HolidayUtility.setHolidayCache(this.settings.holidayCache);
        this.shiftData = Object.assign({}, DEFAULT_DATA, loadedData?.data);
        this.shiftData.shifts = this.shiftData.shifts || [];
        this.shiftData.recurringShifts = this.shiftData.recurringShifts || [];
        this.shiftData.shiftTemplates = this.shiftData.shiftTemplates || [];
        this.shiftData.exchangeRates = this.shiftData.exchangeRates || {};
        this.shiftData.calendarSyncState = this.shiftData.calendarSyncState || {};
        this.shiftData.lastSyncTime = this.shiftData.lastSyncTime || null;
        this.shiftData.lastSyncAttemptTime = this.shiftData.lastSyncAttemptTime || null;
        if (!Number.isInteger(this.settings.statutoryRestDay) || this.settings.statutoryRestDay < -1 || this.settings.statutoryRestDay > 6) this.settings.statutoryRestDay = -1;
        if (!(Number(this.settings.restDayWorkRate) >= 1)) this.settings.restDayWorkRate = DEFAULT_SETTINGS.restDayWorkRate;
        // Stored hours and pay follow the current rules (unentered breaks, late-night hours, holiday by calendar day),
        // including shifts saved by older versions.
        const calculator = new WageCalculator(this.settings);
        for (const shift of this.shiftData.shifts) {
            const result = calculator.calculateShiftWage(shift.date, shift.startTime, shift.endTime, shift.isPaidLeave || false, shift.breakMinutes, shift.storeName);
            shift.calculatedHours = result.totalHours;
            shift.calculatedWage = result.wageAmount;
        }
	}

    /** Re-render open dashboards after a setting changes. */
    refreshDashboards() {
        for (const leaf of this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)) {
            if (leaf.view instanceof DashboardView) leaf.view.render();
        }
    }

    async saveSettings() {
		await this.saveData({
            settings: this.getSerializableSettings(),
            data: this.shiftData
        });
	}

    async saveDataStore() {
		await this.saveData({
            settings: this.getSerializableSettings(),
            data: this.shiftData
        });
	}

    private getSerializableSettings(): JapanWorkSecretarySettings {
        const settingsToSave = {
            ...this.settings,
            storeConfigs: normalizeStoreConfigs(this.settings.storeConfigs)
        };

        settingsToSave.geminiApiKey = '';

        return settingsToSave;
    }

    /** The key is kept in Obsidian's secret storage; settings only hold the secret's name. */
    getGeminiApiKey(): string {
        const name = this.settings.geminiSecretName;
        return (name && this.app.secretStorage.getSecret(name)) || '';
    }

    /**
     * Before 1.4.0 the key lived in the macOS Keychain or in plugin data. Move it
     * into secret storage once, under a shared name other plugins can pick too.
     */
    private async initializeGeminiApiKey() {
        if (this.settings.geminiSecretName) return;
        let legacyKey = this.settings.geminiApiKey || '';
        if (!legacyKey && this.settings.useMacKeychainForGeminiApiKey) {
            try {
                legacyKey = await SecureSecretStore.getGeminiApiKey();
            } catch {
                legacyKey = '';
            }
        }
        if (!legacyKey) return;

        const storage = this.app.secretStorage;
        const shared = storage.getSecret(SHARED_GEMINI_SECRET);
        const name = !shared || shared === legacyKey ? SHARED_GEMINI_SECRET : PLUGIN_GEMINI_SECRET;
        storage.setSecret(name, legacyKey);
        this.settings.geminiSecretName = name;
        this.settings.geminiApiKey = '';
        this.settings.useMacKeychainForGeminiApiKey = false;
        // The Keychain entry is left in place: other vaults may still read it until they upgrade too.
        await this.saveSettings();
    }

    async refreshHolidayCache(force: boolean = false) {
        const cacheAge = Date.now() - (this.settings.holidayCacheUpdatedAt || 0);
        const hasCache = Object.keys(this.settings.holidayCache || {}).length > 0;
        if (!force && hasCache && cacheAge < this.holidayCacheTtlMs) {
            HolidayUtility.setHolidayCache(this.settings.holidayCache);
            return;
        }

        const response = await requestUrl({ url: HolidayUtility.HOLIDAY_API_URL });
        const holidayData = response.json as unknown;

        if (!holidayData || typeof holidayData !== 'object' || Array.isArray(holidayData)) {
            throw new Error('Unexpected holiday API response.');
        }

        const normalized: { [date: string]: string } = {};
        Object.entries(holidayData as Record<string, unknown>).forEach(([date, name]) => {
            if (/^\d{4}-\d{2}-\d{2}$/.test(date) && typeof name === 'string') {
                normalized[date] = name;
            }
        });

        this.settings.holidayCache = normalized;
        this.settings.holidayCacheUpdatedAt = Date.now();
        HolidayUtility.setHolidayCache(normalized);
        await this.saveSettings();
    }
	
    /**
     * Helper to process raw shift data (calc wage, de-duplicate, save, sync)
     */
    async processRawShifts(rawShifts: Shift[]) {
        if (!this.ensureScheduleMutationAllowed()) return;
        if (rawShifts.length === 0) {
            new Notice(tr('No shifts found to process.', '没有找到要处理的班次。'));
            return;
        }

        const calculator = new WageCalculator(this.settings);
        const processedShifts = rawShifts.map(shift => {
            const wageResult = calculator.calculateShiftWage(shift.date, shift.startTime, shift.endTime, shift.isPaidLeave || false, shift.breakMinutes, shift.storeName);
            return {
                ...shift,
                calculatedHours: wageResult.totalHours,
                calculatedWage: wageResult.wageAmount
            }
        });

        const newlyAddedShifts: Shift[] = [];
        for (const newShift of processedShifts) {
            const isDuplicate = this.shiftData.shifts.some(s => 
                s.date === newShift.date && 
                s.startTime === newShift.startTime && 
                s.endTime === newShift.endTime &&
                s.storeName === newShift.storeName
            );

            if (!isDuplicate) {
                this.shiftData.shifts.push(newShift);
                newlyAddedShifts.push(newShift);
            }
        }

        if (newlyAddedShifts.length > 0) {
            await this.saveDataStore();
            new Notice(tr(`Added ${newlyAddedShifts.length} new shifts.`, `新增 ${newlyAddedShifts.length} 个班次。`));

            if (this.calendarSyncInProgress) {
                new Notice(tr('Calendar sync is busy; new shifts were saved and will go out with the next sync.', '日历正在同步。新班次已保存，下次同步时一起写入。'));
                return;
            }
            this.calendarSyncInProgress = true;
            
            try {
                const syncService = new MacCalendarSync(this.settings.calendarName, this.settings.eventTitlePrefix);
                const batch = await syncService.syncMultipleShifts(newlyAddedShifts);
                const syncedAt = new Date().toISOString();

                batch.items.forEach(item => {
                    const shift = newlyAddedShifts.find(candidate => candidate.id === item.shiftId);
                    if (!shift) return;
                    if (item.action) this.recordCalendarSyncSuccess(shift, syncedAt);
                    else this.recordCalendarSyncFailure(shift, syncedAt);
                });
                this.shiftData.lastSyncAttemptTime = syncedAt;
                if (batch.failed === 0) {
                    this.shiftData.lastSyncTime = syncedAt;
                }
                await this.saveDataStore();

                new Notice(this.formatCalendarSyncSummary({
                    created: batch.created,
                    updated: batch.updated,
                    deleted: 0,
                    skipped: 0,
                    failed: batch.failed,
                    total: newlyAddedShifts.length
                }));
            } catch (e) {
                new Notice(tr(`Calendar sync failed: ${errorMessage(e)}`, `日历同步失败：${errorMessage(e)}`));
            } finally {
                this.calendarSyncInProgress = false;
            }
        } else {
            new Notice(tr('No new shifts added (possibly all duplicates).', '没有新增班次（可能都已存在）。'));
        }
    }

    async parseShiftSelection(selection: string) {
        new Notice(tr('Reading shifts from the selection...', '正在从选中文字读取班次……'));
        try {
            const parser = new AIParser(this.getGeminiApiKey(), this.settings.storeConfigs);
            this.reviewDrafts(await parser.parseText(selection), tr('the selected text', '选中的文字'));
        } catch (error) {
            new Notice(tr(`Could not read the selection: ${errorMessage(error)}`, `没能读取选中的文字：${errorMessage(error)}`));
        }
    }

    /** Reads every image embedded in the active note, then shows one review for all of them. */
    async parseShiftImage() {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice(tr('Open a note with a schedule image first.', '请先打开含排班图片的笔记。'));
            return;
        }

        const embeds = this.app.metadataCache.getFileCache(activeFile)?.embeds ?? [];
        const images: TFile[] = [];
        for (const embed of embeds) {
            const file = this.app.metadataCache.getFirstLinkpathDest(embed.link.split('#')[0], activeFile.path);
            if (file && IMAGE_TYPES[file.extension.toLowerCase()] && !images.includes(file)) images.push(file);
        }
        if (images.length === 0) {
            new Notice(tr('No images found in this note.', '这篇笔记里没有图片。'));
            return;
        }

        let parser: AIParser;
        try {
            parser = new AIParser(this.getGeminiApiKey(), this.settings.storeConfigs);
        } catch (error) {
            new Notice(errorMessage(error));
            return;
        }
        new Notice(tr(images.length === 1 ? 'Reading 1 image...' : `Reading ${images.length} images...`, `正在读取 ${images.length} 张图片……`));
        const drafts: ParsedShiftDraft[] = [];
        for (const image of images) {
            try {
                const data = arrayBufferToBase64(await this.app.vault.readBinary(image));
                drafts.push(...await parser.parseImage(data, IMAGE_TYPES[image.extension.toLowerCase()]));
            } catch (error) {
                new Notice(tr(`Could not read ${image.name}: ${errorMessage(error)}`, `没能读取 ${image.name}：${errorMessage(error)}`));
            }
        }
        this.reviewDrafts(drafts, images.length === 1 ? images[0].name : tr(`${images.length} images`, ` ${images.length} 张图片`));
    }

    private reviewDrafts(drafts: ParsedShiftDraft[], source: string) {
        if (drafts.length === 0) {
            new Notice(tr('No shifts found.', '没有找到班次。'));
            return;
        }
        new ShiftReviewModal(this.app, this, drafts, source, async confirmed => {
            await this.processRawShifts(confirmed.map(draftToShift));
        }).open();
    }

    private async writeVaultFile(name: string, content: string): Promise<TFile> {
        const folder = normalizePath(this.settings.exportFolder || DEFAULT_SETTINGS.exportFolder);
        if (!this.app.vault.getFolderByPath(folder)) await this.app.vault.createFolder(folder);
        const path = normalizePath(`${folder}/${name}`);
        const existing = this.app.vault.getFileByPath(path);
        if (existing) {
            await this.app.vault.process(existing, () => content);
            return existing;
        }
        return this.app.vault.create(path, content);
    }

    /** A note with every shift and the estimated pay, to compare with the payslip. */
    async savePayNote(shifts: Shift[], start: string, end: string, total: number) {
        const file = await this.writeVaultFile(`Pay ${start} to ${end}.md`, buildPayNote(shifts, start, end, total, new Date()));
        await this.app.workspace.getLeaf(true).openFile(file);
    }

    async exportIcs(shifts: Shift[]) {
        const file = await this.writeVaultFile('shifts.ics', buildShiftsIcs(shifts, this.settings.eventTitlePrefix, new Date()));
        new Notice(tr(`Saved ${file.path}. Open it to add ${shifts.length === 1 ? 'the shift' : 'the shifts'} to your calendar.`, `已保存 ${file.path}。打开它即可把班次加入日历。`));
    }

    async openDashboard() {
        const { workspace } = this.app;

        let leaf = workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)[0];

        if (!leaf) {
            leaf = workspace.getRightLeaf(false) || workspace.getLeaf(true);
            await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
        }

        await workspace.revealLeaf(leaf);
    }

    private createRecurringShiftForSync(date: string, rule: RecurringShift): Shift {
        const calculator = new WageCalculator(this.settings);
        const wage = calculator.calculateShiftWage(
            date,
            rule.startTime,
            rule.endTime,
            false,
            undefined,
            rule.storeName
        );
        return createRecurringCalendarShift(date, rule, wage.totalHours, wage.wageAmount);
    }

    private recordCalendarSyncSuccess(shift: Shift, syncedAt: string) {
        const calendarName = this.settings.calendarName.trim();
        const stateKey = buildCalendarSyncStateKey(shift.id, calendarName);
        this.shiftData.calendarSyncState[stateKey] = {
            fingerprint: buildCalendarSyncFingerprint(shift, this.settings.calendarName),
            syncedAt,
            status: 'synced',
            calendarName,
            source: parseRecurringInstanceId(shift.id) ? 'recurring' : 'manual',
            shift: {
                id: shift.id,
                date: shift.date,
                startTime: shift.startTime,
                endTime: shift.endTime,
                storeName: shift.storeName
            }
        };

        // Remove an early unscoped record after migrating it to a calendar-scoped key.
        const legacyRecord = this.shiftData.calendarSyncState[shift.id];
        if (
            stateKey !== shift.id &&
            (!legacyRecord?.calendarName || legacyRecord.calendarName.trim() === calendarName)
        ) {
            delete this.shiftData.calendarSyncState[shift.id];
        }

        const manualShift = this.shiftData.shifts.find(candidate => candidate.id === shift.id);
        if (manualShift) manualShift.isSynced = true;
    }

    private recordCalendarSyncFailure(shift: Shift, failedAt: string) {
        const calendarName = this.settings.calendarName.trim();
        const stateKey = buildCalendarSyncStateKey(shift.id, calendarName);
        const previous = getCalendarSyncRecord(
            this.shiftData.calendarSyncState,
            shift.id,
            calendarName
        );
        this.shiftData.calendarSyncState[stateKey] = {
            fingerprint: previous?.fingerprint || buildCalendarSyncFingerprint(shift, calendarName),
            syncedAt: previous?.syncedAt || failedAt,
            status: 'failed',
            failedAt,
            calendarName,
            source: previous?.source || (parseRecurringInstanceId(shift.id) ? 'recurring' : 'manual'),
            shift: previous?.shift ? { ...previous.shift } : {
                id: shift.id,
                date: shift.date,
                startTime: shift.startTime,
                endTime: shift.endTime,
                storeName: shift.storeName
            }
        };

        const legacyRecord = this.shiftData.calendarSyncState[shift.id];
        if (
            stateKey !== shift.id &&
            (!legacyRecord?.calendarName || legacyRecord.calendarName.trim() === calendarName)
        ) {
            delete this.shiftData.calendarSyncState[shift.id];
        }

        const manualShift = this.shiftData.shifts.find(candidate => candidate.id === shift.id);
        if (manualShift) manualShift.isSynced = false;
    }

    isShiftCalendarSynced(shift: Shift): boolean {
        const record = getCalendarSyncRecord(
            this.shiftData.calendarSyncState,
            shift.id,
            this.settings.calendarName
        );
        return record?.status !== 'failed' &&
            record?.fingerprint === buildCalendarSyncFingerprint(shift, this.settings.calendarName);
    }

    hasShiftCalendarRecord(shiftId: string): boolean {
        return Boolean(getCalendarSyncRecord(
            this.shiftData.calendarSyncState,
            shiftId,
            this.settings.calendarName
        ));
    }

    ensureScheduleMutationAllowed(): boolean {
        if (!this.calendarSyncInProgress) return true;
        new Notice(tr('Please wait for Calendar sync to finish before changing the schedule or target calendar.', '请等日历同步完成后再改排班或目标日历。'));
        return false;
    }

    isCalendarSyncRunning(): boolean {
        return this.calendarSyncInProgress;
    }

    private formatCalendarSyncSummary(summary: CalendarSyncSummary): string {
        return [
            tr(`Calendar sync (${summary.total})`, `日历同步（${summary.total}）`),
            tr(`created ${summary.created}`, `新建 ${summary.created}`),
            tr(`updated ${summary.updated}`, `更新 ${summary.updated}`),
            tr(`deleted ${summary.deleted}`, `删除 ${summary.deleted}`),
            tr(`skipped ${summary.skipped}`, `跳过 ${summary.skipped}`),
            tr(`failed ${summary.failed}`, `失败 ${summary.failed}`)
        ].join(' · ');
    }

    async syncShiftToCalendar(shift: Shift): Promise<CalendarSyncAction> {
        if (this.calendarSyncInProgress) {
            throw new Error('Calendar sync is already running.');
        }
        this.calendarSyncInProgress = true;
        const service = new MacCalendarSync(this.settings.calendarName, this.settings.eventTitlePrefix);
        try {
            const action = await service.syncShift(shift);
            const syncedAt = new Date().toISOString();
            this.recordCalendarSyncSuccess(shift, syncedAt);
            this.shiftData.lastSyncTime = syncedAt;
            this.shiftData.lastSyncAttemptTime = syncedAt;
            await this.saveDataStore();
            return action;
        } catch (error) {
            const failedAt = new Date().toISOString();
            this.recordCalendarSyncFailure(shift, failedAt);
            this.shiftData.lastSyncAttemptTime = failedAt;
            await this.saveDataStore();
            throw error;
        } finally {
            this.calendarSyncInProgress = false;
        }
    }

    async deleteShiftFromCalendar(shift: Shift): Promise<void> {
        if (this.calendarSyncInProgress) {
            throw new Error('Calendar sync is already running.');
        }
        this.calendarSyncInProgress = true;
        try {
            const service = new MacCalendarSync(this.settings.calendarName, this.settings.eventTitlePrefix);
            await service.deleteShift(shift);
            invalidateCalendarSyncRecord(
                this.shiftData.calendarSyncState,
                shift.id,
                this.settings.calendarName
            );
            const syncedAt = new Date().toISOString();
            this.shiftData.lastSyncTime = syncedAt;
            this.shiftData.lastSyncAttemptTime = syncedAt;
            await this.saveDataStore();
        } finally {
            this.calendarSyncInProgress = false;
        }
    }

    async smartSyncCalendar(): Promise<CalendarSyncSummary> {
        return this.syncCalendar({ mode: 'smart' });
    }

    async syncCalendarRange(startDate: string, endDate: string, label?: string): Promise<CalendarSyncSummary> {
        return this.syncCalendar({ mode: 'range', startDate, endDate, label });
    }

    /** Backward-compatible command target: this now means force reconciliation. */
    async syncAllShifts(): Promise<CalendarSyncSummary> {
        return this.syncCalendar({ mode: 'full' });
    }

    async syncCalendar(options: CalendarSyncOptions): Promise<CalendarSyncSummary> {
        if (this.calendarSyncInProgress) {
            new Notice(tr('Calendar sync is already running.', '日历正在同步。'));
            return { created: 0, updated: 0, deleted: 0, skipped: 0, failed: 0, total: 0 };
        }
        this.calendarSyncInProgress = true;

        const defaultStart = moment().startOf('month').format('YYYY-MM-DD');
        const defaultEnd = moment().add(3, 'months').endOf('month').format('YYYY-MM-DD');
        const startDate = options.startDate || defaultStart;
        const endDate = options.endDate || defaultEnd;
        const includeAllManualShifts = options.mode !== 'range';
        const force = options.mode === 'full';
        const modeLabel = options.mode === 'smart'
            ? tr('Smart sync', '智能同步')
            : options.mode === 'full'
                ? tr('Force full sync', '全部重写')
                : `${tr('Range sync', '同步本期')}${options.label ? ` (${options.label})` : ''}`;

        new Notice(tr(`${modeLabel}: preparing Calendar changes...`, `${modeLabel}：正在准备日历改动……`));

        try {
            const shifts = collectCalendarSyncShifts(
                this.shiftData,
                startDate,
                endDate,
                includeAllManualShifts,
                (date, rule) => this.createRecurringShiftForSync(date, rule)
            );
            const plan = planCalendarSync(
                shifts,
                this.shiftData.calendarSyncState,
                this.settings.calendarName,
                force,
                this.settings.eventTitlePrefix
            );
            for (const item of plan.skipped) {
                const previous = getCalendarSyncRecord(
                    this.shiftData.calendarSyncState,
                    item.shift.id,
                    this.settings.calendarName
                );
                if (previous) {
                    this.recordCalendarSyncSuccess(item.shift, previous.syncedAt);
                }
            }
            const orphans = findCalendarSyncOrphans(
                shifts,
                this.shiftData.calendarSyncState,
                this.settings.calendarName,
                startDate,
                endDate,
                includeAllManualShifts
            );
            const summary: CalendarSyncSummary = {
                created: 0,
                updated: 0,
                deleted: 0,
                skipped: plan.skipped.length,
                failed: 0,
                total: shifts.length + orphans.length
            };
            const service = new MacCalendarSync(this.settings.calendarName, this.settings.eventTitlePrefix);
            const syncedAt = new Date().toISOString();

            for (const orphan of orphans) {
                try {
                    const action = await service.deleteShift(orphan.shift);
                    if (action === 'deleted') summary.deleted += 1;
                    else summary.skipped += 1;
                    invalidateCalendarSyncRecord(
                        this.shiftData.calendarSyncState,
                        orphan.shift.id,
                        this.settings.calendarName
                    );
                } catch (error) {
                    summary.failed += 1;
                    console.error(`Calendar delete failed for ${orphan.shift.id}.`, error);
                }
            }

            for (const item of plan.toSync) {
                try {
                    const action = await service.syncShift(item.shift);
                    summary[action] += 1;
                    this.recordCalendarSyncSuccess(item.shift, syncedAt);
                } catch (error) {
                    summary.failed += 1;
                    this.recordCalendarSyncFailure(item.shift, syncedAt);
                    console.error(`Calendar sync failed for ${item.shift.id}.`, error);
                }
            }

            this.shiftData.lastSyncAttemptTime = syncedAt;
            if (summary.failed === 0) {
                this.shiftData.lastSyncTime = syncedAt;
            }
            await this.saveDataStore();
            new Notice(this.formatCalendarSyncSummary(summary));
            return summary;
        } catch (error) {
            const message = errorMessage(error);
            new Notice(tr(`Calendar sync failed: ${message}`, `日历同步失败：${message}`));
            return {
                created: 0,
                updated: 0,
                deleted: 0,
                skipped: 0,
                failed: 1,
                total: 0
            };
        } finally {
            this.calendarSyncInProgress = false;
        }
    }
}
