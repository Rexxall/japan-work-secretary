import { execFile } from './shell';
import { Shift } from './data';
import { moment } from './time';

export type CalendarSyncAction = 'created' | 'updated';
export type CalendarDeleteAction = 'deleted' | 'not-found';

export interface CalendarSyncItemResult {
    shiftId: string;
    action?: CalendarSyncAction;
    error?: string;
}

export interface CalendarSyncBatchResult {
    created: number;
    updated: number;
    failed: number;
    items: CalendarSyncItemResult[];
}

export function normalizeCalendarSyncAction(result: string): CalendarSyncAction {
    if (result === 'Synced' || result === 'Created') return 'created';
    if (result === 'Updated') return 'updated';
    throw new Error(`Unexpected Calendar sync result: ${result || '(empty)'}`);
}

export function normalizeCalendarDeleteAction(result: string): CalendarDeleteAction {
    if (result === 'Deleted') return 'deleted';
    if (result === 'Not found') return 'not-found';
    throw new Error(`Unexpected Calendar delete result: ${result || '(empty)'}`);
}

export class MacCalendarSync {
    private calendarName: string;

    constructor(calendarName: string, titlePrefix: string = '打工') {
        this.calendarName = calendarName.trim();
        this.titlePrefix = titlePrefix.trim();
    }

    private titlePrefix: string;

    public buildEventTitle(storeName: string): string {
        return this.titlePrefix ? `${this.titlePrefix}: ${storeName}` : storeName;
    }

    /**
     * Executes an AppleScript via osascript with arguments
     */
    private executeAppleScript(script: string, args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            execFile('/usr/bin/osascript', ['-e', script, ...args], (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`AppleScript Error: ${error.message}\nStderr: ${stderr}`));
                    return;
                }
                resolve(stdout.trim());
            });
        });
    }

    /**
     * Syncs a single shift to Mac Calendar.
     */
    public async syncShift(shift: Shift): Promise<CalendarSyncAction> {
        const startMoment = moment(`${shift.date} ${shift.startTime}`, 'YYYY-MM-DD HH:mm');
        const endMoment = moment(`${shift.date} ${shift.endTime}`, 'YYYY-MM-DD HH:mm');
        
        if (endMoment.isBefore(startMoment)) {
            endMoment.add(1, 'day');
        }

        const eventTitle = this.buildEventTitle(shift.storeName);
        const eventMarker = `JWS_SHIFT_ID:${shift.id}`;
        
        // Pass essential info as arguments to avoid escaping hell and locale issues
        const args = [
            this.calendarName,
            eventTitle,
            shift.storeName,
            // Start components
            startMoment.year().toString(),
            (startMoment.month() + 1).toString(),
            startMoment.date().toString(),
            startMoment.hours().toString(),
            startMoment.minutes().toString(),
            // End components
            endMoment.year().toString(),
            (endMoment.month() + 1).toString(),
            endMoment.date().toString(),
            endMoment.hours().toString(),
            endMoment.minutes().toString(),
            eventMarker
        ];

        const script = `
        on run argv
            set targetCalName to item 1 of argv
            set theSummary to item 2 of argv
            set theLocation to item 3 of argv
            set eventMarker to item 14 of argv

            set startDate to (current date)
            set year of startDate to (item 4 of argv as integer)
            set month of startDate to (item 5 of argv as integer)
            set day of startDate to (item 6 of argv as integer)
            set time of startDate to (item 7 of argv as integer) * 3600 + (item 8 of argv as integer) * 60
            set seconds of startDate to 0

            set endDate to (current date)
            set year of endDate to (item 9 of argv as integer)
            set month of endDate to (item 10 of argv as integer)
            set day of endDate to (item 11 of argv as integer)
            set time of endDate to (item 12 of argv as integer) * 3600 + (item 13 of argv as integer) * 60
            set seconds of endDate to 0

            tell application "Calendar"
                set targetCalendar to missing value
                repeat with aCal in calendars
                    if name of aCal is targetCalName then
                        set targetCalendar to aCal
                        exit repeat
                    end if
                end repeat

                if targetCalendar is missing value then
                    error "Calendar \\"" & targetCalName & "\\" not found."
                end if

                set targetEvent to missing value

                try
                    set markedEvents to (events of targetCalendar whose description contains eventMarker)
                    if (count of markedEvents) > 0 then
                        set targetEvent to item 1 of markedEvents
                    end if
                end try

                -- Get all events for that specific day to be safe
                set startOfDay to (startDate - (time of startDate))
                set endOfDay to (startOfDay + 86399)

                if targetEvent is missing value then
                    set dayEvents to (events of targetCalendar whose start date is greater than or equal to startOfDay and start date is less than or equal to endOfDay)

                    repeat with anEvent in dayEvents
                        if (summary of anEvent is theSummary) and (start date of anEvent is startDate) then
                            set targetEvent to anEvent
                            exit repeat
                        end if
                    end repeat
                end if

                if targetEvent is missing value then
                    set newEvent to make new event at end of events of targetCalendar with properties {summary:theSummary, start date:startDate, end date:endDate, location:theLocation, description:eventMarker}

                    tell newEvent
                        make new display alarm at end of display alarms with properties {trigger interval:-60}
                    end tell
                    return "Synced"
                else
                    set summary of targetEvent to theSummary
                    set start date of targetEvent to startDate
                    set end date of targetEvent to endDate
                    set location of targetEvent to theLocation
                    set description of targetEvent to eventMarker
                    return "Updated"
                end if
            end tell
        end run
        `;

        try {
            const result = await this.executeAppleScript(script, args);
            return normalizeCalendarSyncAction(result);
        } catch (error) {
            console.error("Failed to sync to Calendar.", error);
            throw error;
        }
    }
    
    /**
     * Syncs a batch of shifts
     */
    public async syncMultipleShifts(shifts: Shift[]): Promise<CalendarSyncBatchResult> {
        const result: CalendarSyncBatchResult = {
            created: 0,
            updated: 0,
            failed: 0,
            items: []
        };

        for (const shift of shifts) {
            try {
                const action = await this.syncShift(shift);
                result[action] += 1;
                result.items.push({ shiftId: shift.id, action });
            } catch (error) {
                result.failed += 1;
                result.items.push({
                    shiftId: shift.id,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }

        return result;
    }

    public async deleteShift(shift: Shift): Promise<CalendarDeleteAction> {
        const eventMarker = `JWS_SHIFT_ID:${shift.id}`;

        const args = [
            this.calendarName,
            eventMarker
        ];

        const script = `
        on run argv
            set targetCalName to item 1 of argv
            set eventMarker to item 2 of argv

            tell application "Calendar"
                set targetCalendar to missing value
                repeat with aCal in calendars
                    if name of aCal is targetCalName then
                        set targetCalendar to aCal
                        exit repeat
                    end if
                end repeat

                if targetCalendar is missing value then
                    error "Calendar \\"" & targetCalName & "\\" not found."
                end if

                set markedEvents to (events of targetCalendar whose description is eventMarker)
                set matchCount to count of markedEvents
                if matchCount > 0 then
                    repeat with eventIndex from matchCount to 1 by -1
                        delete item eventIndex of markedEvents
                    end repeat
                    return "Deleted"
                end if

                return "Not found"
            end tell
        end run
        `;

        const result = await this.executeAppleScript(script, args);
        return normalizeCalendarDeleteAction(result);
    }
}
