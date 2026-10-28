import { App, Modal } from 'obsidian';

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
        this.titleEl.setText('Work hours and income: reference');
        const container = contentEl.createDiv({ cls: 'policy-modal-content' });

        const hours = container.createDiv({ cls: 'policy-section' });
        hours.createEl('h3', { text: '1. Hour limits for part-time work on a student visa' });
        const hoursList = hours.createEl('ul');
        hoursList.createEl('li', { text: 'During term: up to 28 hours a week.' });
        hoursList.createEl('li', { text: 'During long vacations set by your school: up to 8 hours a day.' });
        hoursList.createEl('li', { text: 'The plugin checks 28 hours across any 7 consecutive days, and 8 hours per day during long vacations (enter the dates in settings).' });
        hours.createDiv({
            cls: 'policy-alert warning',
            text: 'Whether hours from several jobs are added together, and the exact vacation dates: follow your school and the Immigration Services Agency.'
        });

        const income = container.createDiv({ cls: 'policy-section' });
        income.createEl('h3', { text: '2. Income alerts' });
        const incomeList = income.createEl('ul');
        incomeList.createEl('li', { text: 'Thresholds for income tax, resident tax, social insurance and dependants change from year to year and depend on your situation.' });
        incomeList.createEl('li', { text: 'The plugin has no built-in tax rules. Enter the amounts from this year\'s official guidance in Settings → Income alerts.' });

        const links = container.createDiv({ cls: 'policy-section' });
        links.createEl('h3', { text: 'Official sources (Japanese)' });
        const linkList = links.createEl('ul');
        for (const link of OFFICIAL_LINKS) {
            const li = linkList.createEl('li');
            li.createEl('a', { text: link.label, href: link.url });
        }

        container.createDiv({
            cls: 'policy-footer',
            text: 'This is a reminder only, not legal or tax advice.'
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}
