/** Short explanations shown next to a check, with the official page they rest on. */
import { tr } from './i18n';

export const ISA_STUDENT_WORK_URL = 'https://www.moj.go.jp/isa/applications/procedures/nyuukokukanri07_00003.html';

/** The official page does not say how a week that crosses into the long vacation is counted. */
export function appendMixedWeekNote(el: HTMLElement) {
    el.createEl('strong', { text: tr('Needs checking. ', '需核实：') });
    el.appendText(tr('These 7 days mix term days and the long vacation, and the official page does not say how such a week is counted. Until it does, every hour counts toward 28 h. ', '这 7 天学期日和长假混在一起，官方页面没写这种周怎么算。在拿到依据前，全部工时都算进 28 小时。'));
    el.createEl('a', { text: tr('Official rule', '官方规定'), href: ISA_STUDENT_WORK_URL, attr: { target: '_blank', rel: 'noopener' } });
}

/** One line under a wage preview: hours and pay if the unconfirmed break was taken. */
export function breakUnconfirmedText(ifBreak: { breakMinutes: number; totalHours: number; wageAmount: number }): string {
    return tr(`Break not confirmed, so counted as scheduled. With a ${ifBreak.breakMinutes}-min break: ${ifBreak.totalHours} h · ¥${ifBreak.wageAmount.toLocaleString()}.`, `休息未确认，按排班时长算。扣 ${ifBreak.breakMinutes} 分钟休息是 ${ifBreak.totalHours} 小时 · ¥${ifBreak.wageAmount.toLocaleString()}。`);
}
