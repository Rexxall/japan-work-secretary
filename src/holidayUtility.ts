import moment from 'moment';

export class HolidayUtility {
    public static readonly HOLIDAY_API_URL = 'https://holidays-jp.github.io/api/v1/date.json';

    private static remoteHolidays: { [key: string]: string } = {};

    // Offline fallback for the currently bundled public holiday data.
    private static FALLBACK_HOLIDAYS: { [key: string]: string } = {
        '2025-01-01': '元日',
        '2025-01-13': '成人の日',
        '2025-02-11': '建国記念の日',
        '2025-02-23': '天皇誕生日',
        '2025-02-24': '天皇誕生日 振替休日',
        '2025-03-20': '春分の日',
        '2025-04-29': '昭和の日',
        '2025-05-03': '憲法記念日',
        '2025-05-04': 'みどりの日',
        '2025-05-05': 'こどもの日',
        '2025-05-06': 'みどりの日 振替休日',
        '2025-07-21': '海の日',
        '2025-08-11': '山の日',
        '2025-09-15': '敬老の日',
        '2025-09-23': '秋分の日',
        '2025-10-13': 'スポーツの日',
        '2025-11-03': '文化の日',
        '2025-11-23': '勤労感謝の日',
        '2025-11-24': '勤労感謝の日 振替休日',
        '2026-01-01': '元日',
        '2026-01-12': '成人の日',
        '2026-02-11': '建国記念の日',
        '2026-02-23': '天皇誕生日',
        '2026-03-20': '春分の日',
        '2026-04-29': '昭和の日',
        '2026-05-03': '憲法記念日',
        '2026-05-04': 'みどりの日',
        '2026-05-05': 'こどもの日',
        '2026-05-06': '振替休日',
        '2026-07-20': '海の日',
        '2026-08-11': '山の日',
        '2026-09-21': '敬老の日',
        '2026-09-22': '国民の休日',
        '2026-09-23': '秋分の日',
        '2026-10-12': 'スポーツの日',
        '2026-11-03': '文化の日',
        '2026-11-23': '勤労感謝の日',
        '2027-01-01': '元日',
        '2027-01-11': '成人の日',
        '2027-02-11': '建国記念の日',
        '2027-02-23': '天皇誕生日',
        '2027-03-21': '春分の日',
        '2027-03-22': '春分の日 振替休日',
        '2027-04-29': '昭和の日',
        '2027-05-03': '憲法記念日',
        '2027-05-04': 'みどりの日',
        '2027-05-05': 'こどもの日',
        '2027-07-19': '海の日',
        '2027-08-11': '山の日',
        '2027-09-20': '敬老の日',
        '2027-09-23': '秋分の日',
        '2027-10-11': 'スポーツの日',
        '2027-11-03': '文化の日',
        '2027-11-23': '勤労感謝の日',
    };

    public static setHolidayCache(holidays: { [key: string]: string } = {}) {
        this.remoteHolidays = holidays || {};
    }

    /**
     * Check if a date is a Sunday or a Japanese holiday
     */
    public static isSundayOrHoliday(date: moment.Moment | string, customHolidays: string[] = []): boolean {
        const d = typeof date === 'string' ? moment(date, 'YYYY-MM-DD') : date;
        const dateStr = d.format('YYYY-MM-DD');
        
        // Sunday is always a holiday for wage calculation
        if (d.day() === 0) return true; 
        
        if (HolidayUtility.getHolidayName(dateStr)) return true;

        // Check user custom holidays
        return customHolidays.includes(dateStr);
    }

    /**
     * Get holiday name if it exists
     */
    public static getHolidayName(dateStr: string): string | null {
        return this.remoteHolidays[dateStr] || this.FALLBACK_HOLIDAYS[dateStr] || null;
    }
}
