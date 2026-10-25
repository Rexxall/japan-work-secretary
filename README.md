<div align="center">

# Japan Work Secretary

**Shifts, wages and the 28-hour rule for part-time work in Japan, inside Obsidian.**

在 Obsidian 里管理在日本打工的排班、工资和每周 28 小时上限。

[Features](#features) · [Install](#install) · [Privacy](#privacy) · [How it works](#how-it-works) · [中文说明](#中文说明) · [日本語](#日本語)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/dashboard-dark.jpg">
  <img src="docs/screenshots/dashboard.jpg" width="860">
</picture>

</div>

## Why

Students in Japan who work part-time juggle three things at once: shift schedules that arrive as photos or chat messages, hourly wages that change by time of day and by store, and a legal cap of 28 hours a week. A spreadsheet can do the arithmetic, but it does not warn you before you book the shift that pushes a 7-day window over the limit.

Japan Work Secretary keeps the schedule in your vault, works out the pay the way a Japanese payslip does, and checks every 7-day window as you add shifts.

## Features

### Schedule

- **Month and week views**, each store in its own colour.
- **Add shifts by hand, or as recurring shifts** (for example every Tuesday 17:00–22:00).
- **Read a schedule from text or a photo.** Select a message, or open a note with a screenshot of the roster, and the shifts are extracted for you to review before saving (optional, uses your own Gemini API key).

### Pay

- **Time bands:** morning, daytime, evening and late-night rates, per store.
- **Wage changes with a start date.** When your hourly rate goes up, add a new band from that date; earlier shifts keep the old rate.
- **Breaks:** 45 minutes over 6 hours and 60 minutes over 8 hours are deducted automatically, unless you set a break yourself.
- **Overtime** over 8 hours a day or 40 hours a week, holiday bonus, commuting allowance, and a payroll month that can start on any day (for example the 21st).
- **Japanese public holidays** are fetched and cached; you can add your own.

### Limits

- **28 hours in any 7 days.** The dashboard shows the busiest 7-day window around the selected day and how many hours are left.
- **Long school vacations.** Enter the vacation dates from your school; on those days the plugin checks 8 hours per day instead.
- **Income alert lines.** Set your own monthly or yearly amounts and see how close you are. The plugin does not decide tax for you; thresholds change from year to year, so you enter the numbers that apply to you.

<img src="docs/screenshots/settings-limits.jpg" width="860">

### Calendar

- **Sync to macOS Calendar.** Smart sync only writes shifts that changed since the last sync; a full sync rewrites everything in a range. Events carry a hidden marker, so they are updated in place instead of duplicated.
- **Clean up.** When you sync, events whose shifts you have deleted are removed from the calendar.

## Install

1. Download `japan-work-secretary-1.2.0.zip` from the latest release.
2. Unzip it into `<your vault>/.obsidian/plugins/japan-work-secretary/` (the folder should contain `main.js`, `manifest.json`, `styles.css`).
3. In Obsidian: **Settings → Community plugins → reload**, then enable **Japan Work Secretary**.
4. Open the dashboard from the command palette: **Open Secretary Dashboard**.

Desktop only. Calendar sync needs macOS.

### First-time setup

1. **Settings → Wage Rates:** rename *Store A*, set its hourly rates, add more stores if you have them.
2. **Settings → Compliance & Cycle:** add your school's long vacation dates and any income alert lines you want.
3. Optional: paste a Gemini API key to read schedules from text or photos.

## Privacy

| What | Where it lives |
|---|---|
| Shifts, stores, wages, settings | `data.json` in this plugin's folder in your vault |
| Gemini API key | macOS Keychain by default; plugin data if you turn that off |
| Text or image you choose to parse | Sent to Google Gemini, only when you run a parse command |
| Calendar events | Your local macOS Calendar, through AppleScript |
| Public holidays | Downloaded from `holidays-jp.github.io` |
| JPY → CNY rate (shown next to wages) | Downloaded from `exchangerate-api.com`, `frankfurter.dev` as a fallback |

There is no account and no server of our own.

## How it works

- **28-hour check:** for the selected day, the plugin looks at all seven 7-day windows that include it and reports the largest total. Paid leave and vacation days are not counted toward the weekly limit; vacation days are checked against 8 hours each.
- **Wage bands:** each store keeps a list of rate tables with an `effectiveFrom` date. A shift uses the newest table that started on or before its date.
- **Calendar sync:** every shift gets a fingerprint made only of the fields that appear in the event (date, times, store, calendar, title). Changing a wage does not rewrite your calendar; changing a time does. AppleScript receives values as arguments rather than as text pasted into the script, so store names with quotes or non-Latin characters are safe.
- **Keychain:** the API key is stored with macOS's `security` tool under the service name of this plugin.

Build from source:

```bash
npm install
npm run build     # writes main.js
npm test          # 23 tests: 28-hour windows, vacations, wages, calendar sync planning
```

`styles.css` is generated. Edit `styles/plugin.css` (or the shared `styles/kit.css`, the same in all of my plugins) and run `npm run styles`.

## Known limits

- Rules about hours and income are for reference only. Check your school and the official pages linked in the dashboard (ⓘ).
- Calendar sync works with the macOS Calendar app only.
- Saving a key to the Keychain passes it to the `security` command as an argument, so it is briefly visible to other processes of the same user.
- The interface mixes English and Chinese.

## Changelog

**1.3.0**

- Dashboard redesigned: four numbers at the top (hours, estimated wage, busiest 7 days, income), and the busiest 7 days are marked on the calendar. Shift chips show the store and the time.
- The 7-day card shows the hours of each day in that window.
- Adding a shift shows what it does to the busiest 7 days before you save; above 28 hours the button reads "Save anyway".
- Settings show the default wage bands as one strip across the day.
- Optional **Paper & ink style** in settings. Off by default, so the dashboard follows your theme.
- Styles rewritten from scratch on a small shared style kit; the dashboard no longer uses inline styles.

**1.2.0**

- Long vacation periods with the 8-hour daily check.
- Income alert lines you set yourself, replacing the fixed 8.8万 / 103万 / 130万 toggles (old settings are migrated).
- Configurable calendar event title.
- Policy notes rewritten to stable rules with links to the official pages.
- Breaks can no longer exceed the shift length.
- Store colours cycle through five colours, so any number of stores works; the default store is now a neutral example.

**1.1.0** — Smart, range and full calendar sync with change detection.

## License

MIT

---

## 中文说明

在日本打工的留学生，常常同时要管三件事：排班表（照片或聊天消息）、按时段和店铺变化的时薪，以及每周 28 小时的上限。这个插件把排班放进 Obsidian，按日本工资条的算法算工资，并在你加班次时检查每一个连续 7 天。

- **排班：** 月视图、周视图；固定班次；可从选中的文字或排班截图里识别班次，确认后再保存（可选，用你自己的 Gemini 密钥）。
- **工资：** 早、日、晚、深夜分时段时薪，按店铺设置；时薪上调可按生效日期新增；超过 6 小时自动扣 45 分钟、超过 8 小时扣 60 分钟休息；加班、节假日加给、交通费、从任意一天开始的工资月。
- **上限：** 任意连续 7 天 28 小时；学校长假期间改为每天 8 小时（在设置里填长假日期）；收入提醒线由你按当年规定自己填写，插件不替你判断税额。
- **日历：** 同步到 macOS 日历，只写有变化的班次，用隐藏标记原地更新、不重复。
- **隐私：** 数据都在你的库里；只有在你执行识别命令时，选中的文字或图片才会发给 Gemini。

## 日本語

日本でアルバイトをする留学生向けに、シフト・給与・週28時間の上限を Obsidian の中で管理するプラグインです。

- **シフト：** 月表示・週表示、固定シフト。シフト表の文章やスクリーンショットから読み取り、確認してから保存できます（任意、ご自身の Gemini API キーを使用）。
- **給与：** 朝・日中・夕方・深夜の時給を店舗ごとに設定。時給改定は適用開始日つきで追加。6時間超で45分、8時間超で60分の休憩を自動控除。残業、祝日手当、交通費、締め日にも対応。
- **上限：** 任意の連続7日間で28時間。学校の長期休業期間は1日8時間で確認（期間は設定に入力）。収入の目安額はご自身で設定します。税額の判断はしません。
- **カレンダー：** macOS カレンダーへ同期。変更のあったシフトだけを書き込み、重複を作りません。
- **プライバシー：** データは保管庫の中に保存されます。読み取りを実行したときだけ、選んだ文章や画像が Gemini に送られます。
