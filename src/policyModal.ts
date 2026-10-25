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

        contentEl.createEl('h2', { text: '打工时间与收入：参考说明', cls: 'policy-modal-title' });
        const container = contentEl.createDiv({ cls: 'policy-modal-content' });

        const hours = container.createDiv({ cls: 'policy-section' });
        hours.createEl('h3', { text: '1. 资格外活动的时间上限（留学）' });
        const hoursList = hours.createEl('ul');
        hoursList.createEl('li', { text: '平时：每周 28 小时以内。' });
        hoursList.createEl('li', { text: '学校规定的长期休假期间：每天 8 小时以内。' });
        hoursList.createEl('li', { text: '插件按“任意连续 7 天”检查 28 小时；长假期间改为逐日检查 8 小时（在设置里填写长假日期）。' });
        hours.createDiv({
            cls: 'policy-alert warning',
            text: '多份工作是否合计、长假的具体日期，请以学校和出入国在留管理庁的说明为准。'
        });

        const income = container.createDiv({ cls: 'policy-section' });
        income.createEl('h3', { text: '2. 收入提醒线' });
        const incomeList = income.createEl('ul');
        incomeList.createEl('li', { text: '所得税、住民税、社会保险、扶养的收入界线每年都可能调整，也因个人情况不同。' });
        incomeList.createEl('li', { text: '插件不内置任何税额判断。请在设置的“收入提醒线”里，按当年官方说明自己填写金额。' });

        const links = container.createDiv({ cls: 'policy-section' });
        links.createEl('h3', { text: '官方说明' });
        const linkList = links.createEl('ul');
        for (const link of OFFICIAL_LINKS) {
            const li = linkList.createEl('li');
            li.createEl('a', { text: link.label, href: link.url });
        }

        container.createDiv({
            cls: 'policy-footer',
            text: '※ 本说明只作提醒，不构成法律或税务意见。'
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}
