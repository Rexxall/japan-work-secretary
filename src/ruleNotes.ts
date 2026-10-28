/** Short explanations shown next to a check, with the official page they rest on. */
import { tr } from './i18n';

export const ISA_STUDENT_WORK_URL = 'https://www.moj.go.jp/isa/applications/procedures/nyuukokukanri07_00003.html';

/** The official page does not say how a week that crosses into the long vacation is counted. */
export function appendMixedWeekNote(el: HTMLElement) {
    el.appendText(tr('This week mixes term days and the long vacation, so all its hours count toward 28 h, the stricter reading. ', '这一周学期日和长假混在一起，按更严格的理解，全部工时都算进 28 小时。'));
    el.createEl('a', { text: tr('Official rule', '官方规定'), href: ISA_STUDENT_WORK_URL, attr: { target: '_blank', rel: 'noopener' } });
}

export function breakMissingText(requiredMinutes: number): string {
    return tr(`No break entered. Counted as scheduled; if you took a break (at least ${requiredMinutes} min is required for this length), enter it.`, `没填休息，按排班时长计算。如果休息了（这个时长至少要休 ${requiredMinutes} 分钟），请填上。`);
}
