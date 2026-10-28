/** Short explanations shown next to a check, with the official page they rest on. */

export const ISA_STUDENT_WORK_URL = 'https://www.moj.go.jp/isa/applications/procedures/nyuukokukanri07_00003.html';

/** The official page does not say how a week that crosses into the long vacation is counted. */
export function appendMixedWeekNote(el: HTMLElement) {
    el.appendText('This week mixes term days and the long vacation, so all its hours count toward 28 h, the stricter reading. ');
    el.createEl('a', { text: 'Official rule', href: ISA_STUDENT_WORK_URL, attr: { target: '_blank', rel: 'noopener' } });
}

export function breakMissingText(requiredMinutes: number): string {
    return `No break entered. Counted as scheduled; if you took a break (at least ${requiredMinutes} min is required for this length), enter it.`;
}
