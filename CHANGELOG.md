# Changelog

## 1.5.0

- **AI for reading schedules.** Choose the service, address, model and key separately, with presets for DeepSeek (default), Qwen, SiliconFlow, Kimi, Zhipu GLM, Gemini, OpenAI and any OpenAI-compatible or local server. A Gemini key from 1.4.x carries over.
- **Model list and test connection.** Fetch the models your key can use (free). The test checks the model list, then sends one tiny request, and names the problem: no key, key rejected, out of balance or quota, model not found, rate limited, no reply in time, or the service could not be reached. A copy button gives diagnostics without the key or any shift content.
- **Progress, Cancel and Retry** while a roster is read; *Open settings* when the key is missing or rejected. With several images, those that worked still reach the check list.
- **A sample week** for an empty dashboard: five shifts at *Sample store*, never synced or exported, removable in one click.
- The interface follows Obsidian's language through `getLanguage()`; a few remaining English-only labels are translated.
- Pay figures shrink to stay inside their card in narrow panes.
- README in English and Chinese, with what is sent where and what it costs.
- Settings rows, group titles, list chevrons and separators share one left and one right edge, on store and income-alert pages too. Section titles outside cards line up with the text inside them; *Add a single shift* opens with a chevron on the right.

## 1.4.0

- New look in the style of current Apple apps: solid cards and grouped lists, a glass header bar and glass dialogs, settings drawn as grouped lists. Follows your theme and accent colour; glass turns solid when the system asks for reduced transparency. The paper style option is gone.
- Breaks are no longer deducted automatically. A shift without an entered break counts as scheduled and is marked *No break entered*; the add-shift dialog has a break field.
- A 7-day window that mixes term days and the long vacation is now held to 28 hours with all its hours (previously vacation days were left out), and is marked with a link to the official page.
- Shifts read by the AI open in a check list before anything is saved: edit or untick rows, see duplicates and rows that would break the 28-hour or 8-hour rule.
- *Save pay note*: a Markdown note with every shift, totals by store and overtime, to check against your payslip.
- *Export .ics* for Google Calendar, Outlook and phones.
- The Gemini key moves to Obsidian's secret storage and can be shared with other plugins.
- Requires Obsidian 1.13: settings use Obsidian's own pages and lists (stores, wage bands and income alerts can be added and removed there) and show up in settings search.
- Late-night hours are named as what they are, 22:00–05:00, and the store's Sunday and holiday bonus goes by the calendar day of each hour, so a Saturday night shift gets it only after midnight.
- The statutory rest day (法定休日) premium is a separate setting, off until you name the day; the legal minimum rate is 1.35.
- Income alerts switched on in 1.1.x stay on after the upgrade (they were reset before). Stored hours and pay are recalculated with the current rules on start.
- Gemini is called through Obsidian's `requestUrl` instead of Google's SDK; the plugin file is about 170 KB instead of 960 KB. Images are read from the vault instead of the file system.
- The AI prompt no longer assumes a particular store or the year 2026.
- Deleting a recurring shift or a template takes a second click instead of a browser dialog. Settings and commands use sentence case and Obsidian's own section headings.

## 1.3.0

- Dashboard redesigned: four numbers at the top (hours, estimated wage, busiest 7 days, income), and the busiest 7 days are marked on the calendar. Shift chips show the store and the time.
- The 7-day card shows the hours of each day in that window.
- Adding a shift shows what it does to the busiest 7 days before you save; above 28 hours the button reads "Save anyway".
- Settings show the default wage bands as one strip across the day.
- Chinese interface when Obsidian is set to Chinese; English otherwise. Dates follow the same language.
- A quieter dashboard: only Overview and Manage at the top, month or week beside the calendar, hours and pay in one card, shifts as thin capsules. Counting by calendar or work month and the three calendar sync modes moved to the ⋯ menu.
- Styles rewritten from scratch on a small shared style kit; the dashboard no longer uses inline styles.

## 1.2.0

- Long vacation periods with the 8-hour daily check.
- Income alert lines you set yourself, replacing the fixed 8.8万 / 103万 / 130万 toggles (old settings are migrated).
- Configurable calendar event title.
- Policy notes rewritten to stable rules with links to the official pages.
- Breaks can no longer exceed the shift length.
- Store colours cycle through five colours, so any number of stores works; the default store is now a neutral example.

## 1.1.0

- Smart, range and full calendar sync with change detection.
