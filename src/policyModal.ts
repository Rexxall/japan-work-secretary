import { App, Modal } from 'obsidian';
import { tr } from './i18n';

interface PolicyLink {
    label: string;
    url: string;
}

const OFFICIAL_LINKS: PolicyLink[] = [
    {
        label: '出入国在留管理庁｜「留学」の在留資格に係る資格外活動許可について',
        url: 'https://www.moj.go.jp/isa/applications/procedures/nyuukokukanri07_00003.html'
    },
    {
        label: '国税庁｜令和7年度税制改正による所得税の基礎控除の見直し等について',
        url: 'https://www.nta.go.jp/users/gensen/2025kiso/index.htm'
    },
    {
        label: '国税庁｜租税条約に基づく留学生の免税（質疑応答）',
        url: 'https://www.nta.go.jp/law/shitsugi/gensen/06/62.htm'
    },
    {
        label: '厚生労働省｜労働時間・休日',
        url: 'https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/koyou_roudou/roudoukijun/roudouzikan/index.html'
    }
];

export class PolicyExplanationModal extends Modal {
    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('jws-policy-modal');
        this.modalEl.addClass('jws-modal');
        this.titleEl.setText(tr('Work hours and income: reference', '工时与收入：参考'));
        const container = contentEl.createDiv({ cls: 'policy-modal-content' });

        const hours = container.createDiv({ cls: 'policy-section' });
        hours.createEl('h3', { text: tr('1. Hour limits for part-time work on a student visa', '1. 留学签证打工的工时上限') });
        const hoursList = hours.createEl('ul');
        hoursList.createEl('li', { text: tr('During term: up to 28 hours a week.', '学期中：每周最多 28 小时。') });
        hoursList.createEl('li', { text: tr('During long vacations set by your school: up to 8 hours a day.', '学校规定的长假期间：每天最多 8 小时。') });
        hoursList.createEl('li', { text: tr('The plugin checks 28 hours across any 7 consecutive days, and 8 hours per day during long vacations (enter the dates in settings).', '本插件按任意连续 7 天检查 28 小时，长假期间按每天 8 小时检查（日期在设置里填）。') });
        hours.createDiv({
            cls: 'policy-alert warning',
            text: tr('Whether hours from several jobs are added together, and the exact vacation dates: follow your school and the Immigration Services Agency.', '几份工的工时是否合算、长假的具体日期，以学校和出入国在留管理厅为准。')
        });

        const income = container.createDiv({ cls: 'policy-section' });
        income.createEl('h3', { text: tr('2. Income alerts', '2. 收入提醒') });
        const incomeList = income.createEl('ul');
        incomeList.createEl('li', { text: tr('Thresholds for income tax, resident tax, social insurance and dependants change from year to year and depend on your situation.', '所得税、住民税、社保和扶养的门槛每年会变，也因人而异。') });
        incomeList.createEl('li', { text: tr('The plugin has no built-in tax rules. Enter the amounts from this year\'s official guidance in Settings → Income alerts.', '本插件不内置税务规则。请按今年的官方说明，在 设置 → 收入提醒 填金额。') });

        const links = container.createDiv({ cls: 'policy-section' });
        links.createEl('h3', { text: tr('Official sources (Japanese)', '官方出处（日文）') });
        const linkList = links.createEl('ul');
        for (const link of OFFICIAL_LINKS) {
            const li = linkList.createEl('li');
            li.createEl('a', { text: link.label, href: link.url });
        }

        container.createDiv({
            cls: 'policy-footer',
            text: tr('This is a reminder only, not legal or tax advice.', '这里只是提醒，不构成法律或税务建议。')
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}
