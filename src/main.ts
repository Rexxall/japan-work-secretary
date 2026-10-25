import { Plugin, Notice, Editor, requestUrl } from 'obsidian';
import { JapanWorkSecretarySettingTab, DEFAULT_SETTINGS, JapanWorkSecretarySettings, migrateIncomeAlerts } from './settings';
import { JapanWorkSecretaryData, DEFAULT_DATA, RecurringShift, Shift, normalizeStoreConfigs, parseRecurringInstanceId } from './data';
import { DashboardView, DASHBOARD_VIEW_TYPE } from './dashboardView';
import { AIParser } from './aiParser';
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
import moment from 'moment';

export interface JapanWorkSecretaryPluginData {
    settings: JapanWorkSecretarySettings;
    data: JapanWorkSecretaryData;
}

const DEFAULT_PLUGIN_DATA: JapanWorkSecretaryPluginData = {
    settings: DEFAULT_SETTINGS,
    data: DEFAULT_DATA
};

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

export default class JapanWorkSecretaryPlugin extends Plugin {
	settings: JapanWorkSecretarySettings;
    shiftData: JapanWorkSecretaryData;
    private readonly holidayCacheTtlMs = 7 * 24 * 60 * 60 * 1000;
    private runtimeGeminiApiKey: string = '';
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
            name: 'Parse Shift from Selected Text',
            editorCallback: (editor: Editor) => {
                const selection = editor.getSelection();
                if (!selection) {
                    new Notice('Please select some text containing shift info.');
                    return;
                }
                this.parseShiftSelection(selection);
            }
        });

        this.addCommand({
            id: 'parse-shift-image',
            name: 'Parse Shift from Current Note Image',
            callback: () => this.parseShiftImage()
        });

        this.addCommand({
            id: 'open-dashboard',
            name: 'Open Secretary Dashboard',
            callback: () => this.openDashboard()
        });

        this.addCommand({
            id: 'sync-smart-to-calendar',
            name: 'Smart Sync Shifts to macOS Calendar',
            callback: () => this.smartSyncCalendar()
        });

        this.addCommand({
            id: 'sync-all-to-calendar',
            name: 'Force Full Sync to macOS Calendar',
            callback: () => this.syncAllShifts()
        });

        this.addCommand({
            id: 'refresh-japanese-holidays',
            name: 'Refresh Japanese holiday cache',
            callback: async () => {
                await this.refreshHolidayCache(true);
                new Notice('Japanese holiday cache refreshed.');
            }
        });

		console.log('Japan Work Secretary plugin loaded');
	}

	onunload() {
		console.log('Japan Work Secretary plugin unloaded');
	}

	async loadDataStore() {
        // Load data, handling cases where it might be empty or missing properties
		const loadedData = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData?.settings);
        this.settings.storeConfigs = normalizeStoreConfigs(this.settings.storeConfigs);
        this.settings.incomeAlerts = migrateIncomeAlerts(this.settings);
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
	}

    /** Re-render open dashboards, e.g. after the paper style is switched. */
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

        if (settingsToSave.useMacKeychainForGeminiApiKey) {
            settingsToSave.geminiApiKey = '';
        }

        return settingsToSave;
    }

    getGeminiApiKey(): string {
        return this.runtimeGeminiApiKey || this.settings.geminiApiKey || '';
    }

    async setGeminiApiKey(apiKey: string) {
        this.runtimeGeminiApiKey = apiKey;

        if (this.settings.useMacKeychainForGeminiApiKey) {
            try {
                await SecureSecretStore.setGeminiApiKey(apiKey);
                this.settings.geminiApiKey = '';
            } catch (error) {
                console.error('Failed to save Gemini API key to macOS Keychain.', error);
                this.settings.geminiApiKey = apiKey;
                this.settings.useMacKeychainForGeminiApiKey = false;
                new Notice('Keychain save failed; Gemini key remains in plugin data.');
            }
        } else {
            this.settings.geminiApiKey = apiKey;
        }

        await this.saveSettings();
    }

    private async initializeGeminiApiKey() {
        if (!this.settings.useMacKeychainForGeminiApiKey) {
            this.runtimeGeminiApiKey = this.settings.geminiApiKey || '';
            return;
        }

        const legacyPlaintextKey = this.settings.geminiApiKey;
        if (legacyPlaintextKey) {
            this.runtimeGeminiApiKey = legacyPlaintextKey;
            try {
                await SecureSecretStore.setGeminiApiKey(legacyPlaintextKey);
                this.settings.geminiApiKey = '';
                await this.saveSettings();
            } catch (error) {
                console.error('Failed to migrate Gemini API key to macOS Keychain.', error);
                this.settings.useMacKeychainForGeminiApiKey = false;
                await this.saveSettings();
            }
            return;
        }

        try {
            this.runtimeGeminiApiKey = await SecureSecretStore.getGeminiApiKey();
        } catch (error) {
            this.runtimeGeminiApiKey = '';
        }
    }

    async refreshHolidayCache(force: boolean = false) {
        const cacheAge = Date.now() - (this.settings.holidayCacheUpdatedAt || 0);
        const hasCache = Object.keys(this.settings.holidayCache || {}).length > 0;
        if (!force && hasCache && cacheAge < this.holidayCacheTtlMs) {
            HolidayUtility.setHolidayCache(this.settings.holidayCache);
            return;
        }

        const response = await requestUrl({ url: HolidayUtility.HOLIDAY_API_URL });
        const holidayData = response.json;

        if (!holidayData || typeof holidayData !== 'object' || Array.isArray(holidayData)) {
            throw new Error('Unexpected holiday API response.');
        }

        const normalized: { [date: string]: string } = {};
        Object.entries(holidayData).forEach(([date, name]) => {
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
    async processRawShifts(rawShifts: any[]) {
        if (!this.ensureScheduleMutationAllowed()) return;
        if (rawShifts.length === 0) {
            new Notice('No shifts found to process.');
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
            new Notice(`Added ${newlyAddedShifts.length} new shifts.`);

            if (this.calendarSyncInProgress) {
                new Notice('Calendar sync is busy; new shifts were saved locally and will be picked up by Smart sync.');
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
                new Notice(`Calendar sync failed: ${e.message}`);
            } finally {
                this.calendarSyncInProgress = false;
            }
        } else {
            new Notice('No new shifts added (possibly all duplicates).');
        }
    }

    async parseShiftSelection(selection: string) {
        new Notice('AI parsing selected text...');
        try {
            const parser = new AIParser(this.getGeminiApiKey(), this.settings.storeConfigs);
            const rawShifts = await parser.parseText(selection);
            await this.processRawShifts(rawShifts);
        } catch (error: any) {
            new Notice(`Error parsing selection: ${error.message}`);
            console.error('Error parsing selection:', error);
        }
    }

	async parseShiftImage() {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice('No active file selected.');
			return;
		}

		const content = await this.app.vault.read(activeFile);
		
		// Find all markdown images ![[alt]](url) and Obsidian wikilinks ![[image.png]]
		const mdImageRegex = /!\[.*?\]\((.*?)\)/g;
		const wikiImageRegex = /!\[\[(.*?)\]\]/g;
		
		const imageNames: string[] = [];
		let match;
		
		while ((match = mdImageRegex.exec(content)) !== null) {
			imageNames.push(match[1]);
		}
		while ((match = wikiImageRegex.exec(content)) !== null) {
			imageNames.push(match[1]);
		}

		if (imageNames.length === 0) {
			new Notice('No images found in the active file.');
			return;
		}
		
		new Notice(`Found ${imageNames.length} image(s). Starting AI OCR batch processing...`);
		
		const allFiles = this.app.vault.getFiles();

		for (const imageName of imageNames) {
			const imageFile = allFiles.find(f => f.name === imageName || f.path.endsWith(imageName));

			if (!imageFile) {
				console.warn(`Image file ${imageName} not found in vault.`);
				continue;
			}

			// Get absolute path
			const absoluteImagePath = (this.app.vault.adapter as any).getBasePath() + '/' + imageFile.path;
			
			// Mime Type guessing
			let mimeType = 'image/jpeg';
			if (imageName.toLowerCase().endsWith('.png')) mimeType = 'image/png';
			else if (imageName.toLowerCase().endsWith('.webp')) mimeType = 'image/webp';
			
			try {
				const parser = new AIParser(this.getGeminiApiKey(), this.settings.storeConfigs);
				const rawShifts = await parser.parseLocalImage(absoluteImagePath, mimeType);
				await this.processRawShifts(rawShifts);
			} catch (error: any) {
				console.error(`Error processing ${imageName}:`, error);
				new Notice(`Error processing ${imageName}: ${error.message}`);
			}
		}
	}

    async openDashboard() {
        const { workspace } = this.app;

        let leaf = workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)[0];

        if (!leaf) {
            leaf = workspace.getRightLeaf(false) || workspace.getLeaf(true);
            await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
        }

        workspace.revealLeaf(leaf);
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
        new Notice('Please wait for Calendar sync to finish before changing the schedule or target calendar.');
        return false;
    }

    isCalendarSyncRunning(): boolean {
        return this.calendarSyncInProgress;
    }

    private formatCalendarSyncSummary(summary: CalendarSyncSummary): string {
        return [
            `Calendar sync (${summary.total})`,
            `created ${summary.created}`,
            `updated ${summary.updated}`,
            `deleted ${summary.deleted}`,
            `skipped ${summary.skipped}`,
            `failed ${summary.failed}`
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
            new Notice('Calendar sync is already running.');
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
            ? 'Smart sync'
            : options.mode === 'full'
                ? 'Force full sync'
                : `Range sync${options.label ? ` (${options.label})` : ''}`;

        new Notice(`${modeLabel}: preparing Calendar changes...`);

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
        } catch (error: any) {
            const message = error?.message || String(error);
            new Notice(`Calendar sync failed: ${message}`);
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
