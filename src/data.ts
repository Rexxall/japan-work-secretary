export interface Shift {
    id: string; // unique identifier
    date: string; // YYYY-MM-DD
    startTime: string; // HH:mm
    endTime: string; // HH:mm
    storeName: string; // e.g., "Store A"
    calculatedWage: number;
    calculatedHours: number; // Decimal hours
    isPaidLeave?: boolean;
    breakMinutes?: number; // Custom break override in minutes
    isSynced?: boolean; // Track if synced to calendar
    /** Sample shift loaded from the empty dashboard; never synced or exported, removed together. */
    isSample?: boolean;
}

export interface CalendarSyncRecord {
    fingerprint: string;
    syncedAt: string;
    status?: 'synced' | 'failed';
    failedAt?: string;
    calendarName?: string;
    source?: 'manual' | 'recurring';
    shift?: {
        id: string;
        date: string;
        startTime: string;
        endTime: string;
        storeName: string;
    };
}

export interface WageBandConfig {
    baseWage: number;
    morningWage: number;
    eveningWage: number;
    nightWage: number;
    holidayBonus?: number;
    commutingAllowance?: number;
}

export interface EffectiveWageBandConfig extends WageBandConfig {
    effectiveFrom: string; // YYYY-MM-DD
}

export interface StoreConfig extends WageBandConfig {
    id: string;
    name: string;
    aliases: string[];
    shortName?: string;
    colorClass?: string;
    wageBands?: EffectiveWageBandConfig[];
}

export interface WageSettingsFallback extends WageBandConfig {
    storeConfigs?: StoreConfig[];
}

export const DEFAULT_STORE_CONFIGS: StoreConfig[] = [
    {
        id: 'store-a',
        name: 'Store A',
        aliases: ['Store A', 'A'],
        shortName: 'A',
        colorClass: 'store-0',
        baseWage: 1200,
        morningWage: 1300,
        eveningWage: 1250,
        nightWage: 1500,
        holidayBonus: 0,
        commutingAllowance: 0,
        wageBands: [
            {
                effectiveFrom: '0000-01-01',
                baseWage: 1200,
                morningWage: 1300,
                eveningWage: 1250,
                nightWage: 1500,
                holidayBonus: 0,
                commutingAllowance: 0
            }
        ]
    }
];

export function cloneDefaultStoreConfigs(): StoreConfig[] {
    return DEFAULT_STORE_CONFIGS.map(store => ({
        ...store,
        aliases: [...store.aliases],
        wageBands: store.wageBands?.map(band => ({ ...band }))
    }));
}

function normalizeWageBands(store: StoreConfig, fallback: StoreConfig): EffectiveWageBandConfig[] {
    const sourceBands = store.wageBands && store.wageBands.length > 0
        ? store.wageBands
        : fallback.wageBands;

    const bands = sourceBands && sourceBands.length > 0
        ? sourceBands
        : [{
            effectiveFrom: '0000-01-01',
            baseWage: store.baseWage ?? fallback.baseWage,
            morningWage: store.morningWage ?? fallback.morningWage,
            eveningWage: store.eveningWage ?? fallback.eveningWage,
            nightWage: store.nightWage ?? fallback.nightWage,
            holidayBonus: store.holidayBonus ?? fallback.holidayBonus,
            commutingAllowance: store.commutingAllowance ?? fallback.commutingAllowance
        }];

    return bands
        .map(band => ({
            effectiveFrom: band.effectiveFrom || '0000-01-01',
            baseWage: Number(band.baseWage ?? store.baseWage ?? fallback.baseWage),
            morningWage: Number(band.morningWage ?? store.morningWage ?? fallback.morningWage),
            eveningWage: Number(band.eveningWage ?? store.eveningWage ?? fallback.eveningWage),
            nightWage: Number(band.nightWage ?? store.nightWage ?? fallback.nightWage),
            holidayBonus: Number(band.holidayBonus ?? store.holidayBonus ?? fallback.holidayBonus ?? 0),
            commutingAllowance: Number(band.commutingAllowance ?? store.commutingAllowance ?? fallback.commutingAllowance ?? 0)
        }))
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
}

export function normalizeStoreConfigs(stores?: StoreConfig[]): StoreConfig[] {
    if (!stores || stores.length === 0) return cloneDefaultStoreConfigs();

    return stores.map((store, index) => {
        const fallback = DEFAULT_STORE_CONFIGS[index] || DEFAULT_STORE_CONFIGS[0];
        const name = store.name || fallback.name;
        const wageBands = normalizeWageBands(store, fallback);
        const latestBand = wageBands[wageBands.length - 1];
        return {
            ...fallback,
            ...store,
            id: store.id || name,
            name,
            aliases: store.aliases && store.aliases.length > 0 ? store.aliases : [name],
            shortName: store.shortName || name,
            colorClass: store.colorClass || `store-${index % 5}`,
            baseWage: latestBand.baseWage,
            morningWage: latestBand.morningWage,
            eveningWage: latestBand.eveningWage,
            nightWage: latestBand.nightWage,
            holidayBonus: latestBand.holidayBonus,
            commutingAllowance: latestBand.commutingAllowance,
            wageBands
        };
    });
}

export function findStoreConfig(settings: WageSettingsFallback, storeName: string): StoreConfig {
    const normalizedStores = normalizeStoreConfigs(settings.storeConfigs);
    const normalizedName = (storeName || '').trim();
    return normalizedStores.find(store =>
        store.name === normalizedName || store.aliases.some(alias => alias === normalizedName)
    ) || normalizedStores[0];
}

export function getStoreWageBand(settings: WageSettingsFallback, storeName: string, date: string = '9999-12-31'): WageBandConfig {
    const store = findStoreConfig(settings, storeName);
    const wageBands = normalizeWageBands(store, store);
    const matchedBand = wageBands
        .filter(band => band.effectiveFrom <= date)
        .pop() || wageBands[0];

    return {
        baseWage: Number(matchedBand.baseWage ?? store.baseWage ?? settings.baseWage),
        morningWage: Number(matchedBand.morningWage ?? store.morningWage ?? settings.morningWage),
        eveningWage: Number(matchedBand.eveningWage ?? store.eveningWage ?? settings.eveningWage),
        nightWage: Number(matchedBand.nightWage ?? store.nightWage ?? settings.nightWage),
        holidayBonus: Number(matchedBand.holidayBonus ?? store.holidayBonus ?? settings.holidayBonus ?? 0),
        commutingAllowance: Number(matchedBand.commutingAllowance ?? store.commutingAllowance ?? settings.commutingAllowance ?? 0)
    };
}

export function getStoreDisplayName(settings: WageSettingsFallback, storeName: string): string {
    return findStoreConfig(settings, storeName).name;
}

export function getStoreShortName(settings: WageSettingsFallback, storeName: string): string {
    const store = findStoreConfig(settings, storeName);
    return store.shortName || store.name;
}

export function getStoreColorClass(settings: WageSettingsFallback, storeName: string): string {
    return findStoreConfig(settings, storeName).colorClass || 'store-default';
}

export interface RecurringInstanceIdParts {
    ruleId: string;
    date: string;
}

export function buildRecurringInstanceId(ruleId: string, date: string): string {
    return `recurring::${encodeURIComponent(ruleId)}::${date}`;
}

export function parseRecurringInstanceId(id: string): RecurringInstanceIdParts | null {
    const modernMatch = id.match(/^recurring::(.+)::(\d{4}-\d{2}-\d{2})$/);
    if (modernMatch) {
        return {
            ruleId: decodeURIComponent(modernMatch[1]),
            date: modernMatch[2]
        };
    }

    const legacyMatch = id.match(/^recurring-(.+)-(\d{4}-\d{2}-\d{2})$/);
    if (legacyMatch) {
        return {
            ruleId: legacyMatch[1],
            date: legacyMatch[2]
        };
    }

    return null;
}

export interface RecurringShift {
    id: string;
    dayOfWeek: number; // 0 (Sun) to 6 (Sat)
    startTime: string; // HH:mm
    endTime: string; // HH:mm
    storeName: string;
    startDate?: string; // YYYY-MM-DD
    endDate?: string;   // YYYY-MM-DD
    exceptions?: string[]; // Array of YYYY-MM-DD to skip
}

export interface ShiftTemplatePattern {
    dayOfWeek: number; // 0 (Sun) to 6 (Sat)
    startTime: string; // HH:mm
    endTime: string; // HH:mm
    storeName: string;
}

export interface ShiftTemplate {
    id: string;
    name: string;
    patterns: ShiftTemplatePattern[];
    createdAt: string;
    updatedAt: string;
}

export interface ExchangeRateSnapshot {
    date: string; // Payroll date used for this snapshot, YYYY-MM-DD
    rate: number; // 1 JPY to CNY
    provider: string;
    providerDate?: string; // Date returned by the provider, YYYY-MM-DD
    fetchedAt: string;
}

export interface JapanWorkSecretaryData {
    shifts: Shift[];
    recurringShifts: RecurringShift[];
    shiftTemplates: ShiftTemplate[];
    exchangeRates: { [payDate: string]: ExchangeRateSnapshot };
    calendarSyncState: { [calendarAndShiftId: string]: CalendarSyncRecord };
    lastSyncTime: string | null;
    lastSyncAttemptTime: string | null;
}

export const DEFAULT_DATA: JapanWorkSecretaryData = {
    shifts: [],
    recurringShifts: [],
    shiftTemplates: [],
    exchangeRates: {},
    calendarSyncState: {},
    lastSyncTime: null,
    lastSyncAttemptTime: null
};
