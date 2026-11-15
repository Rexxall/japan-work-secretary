Copy the prompt for your problem into your AI coding assistant, replacing `<vault>` with your vault folder.

## AI test fails or a roster is not read

```text
Japan Work Secretary's AI test fails, or reading a roster returns no shifts. Help me find and fix the cause.
You may inspect and change only <vault>/.obsidian/plugins/japan-work-secretary/. If needed, read only the note I name. Do not access other plugins or notes, or change any note. Stop and ask before deleting anything.
Check the provider, endpoint, model and selected key name. Ask for the diagnostics from the copy button beside Test, never the key itself. Keys are in Obsidian's secret storage on this device; ask me to choose the key in settings. Distinguish a missing or rejected key, balance or quota problems, an unknown model, rate limiting, timeout and an unreachable service. For photos, check that the model supports images and inspect image handling only for the note I name. With several images, identify which failed without discarding successful results. Do not reset data.json.
To confirm the fix, have me press Test under AI for reading schedules and check for a successful response. Then have me select a short made-up roster for a configured store and run Read shifts from selected text. A review list should show the expected date, start and end time, with nothing saved until I press Save. If photos were the problem, have me repeat with a named demo image. I will run these checks because they send content to my AI provider and use its quota.
```

## Shifts do not sync to macOS Calendar

```text
Japan Work Secretary does not sync my shifts to macOS Calendar, or creates duplicate events. Help me find and fix the cause.
You may inspect and change only <vault>/.obsidian/plugins/japan-work-secretary/. If needed, read only the note I name. Do not access other plugins or notes, or change any note. Stop and ask before deleting anything.
Ask me to confirm I am on macOS and provide the exact sync error and configured macOS Calendar name. Check the plugin's calendarName, calendarSyncState, event markers, fingerprints and AppleScript argument handling. Sample shifts are deliberately excluded. Ask whether I changed the target calendar: existing events in the old calendar are not removed automatically. Do not edit Calendar's files or system permissions; tell me which setting I need to check myself. Do not clear sync state or remove events as a shortcut.
To confirm the fix, have me choose one existing non-sample shift and run sync for its date range. I will check that the target calendar has one matching event with the expected store, date and start/end times. I will sync the unchanged range again and confirm no duplicate appears. Sync can create, update or remove events, so I will run it and ask you to stop before any deletion.
```

## Hours or pay do not match the break I entered

```text
Japan Work Secretary shows unexpected hours or pay after I enter a break. Help me find and fix the cause.
You may inspect and change only <vault>/.obsidian/plugins/japan-work-secretary/. If needed, read only the note I name. Do not access other plugins or notes, or change any note. Stop and ask before deleting anything.
Inspect the chosen shift in data.json, its breakMinutes and breakConfirmed values, the store's effectiveFrom wage band, time bands, overtime and vacation settings. An unconfirmed break is not deducted from the main hours or pay; the deducted result is a comparison. Confirmed breaks are deducted. Paid leave is excluded from the 28-hour check. Mixed term/vacation windows keep all hours in that check and show Needs checking. Compare the stored values with the plugin's calculation without changing my shift history to make the result fit.
To confirm the fix, evaluate a made-up 09:00–16:00 shift with a 45-minute break using the calculation code inside the allowed folder, without saving a shift or syncing Calendar. Unconfirmed should count 7 hours and show 6.25 hours as the comparison; confirmed should count 6.25 hours. Use a flat hourly rate with no extras and check that pay uses the corresponding hours. Then have me reopen the original shift and check its displayed hours and wage against its actual settings.
```

## The Deadlines view is missing or empty

```text
Japan Work Secretary's Deadlines view is missing from Bases, or it shows no dated notes. Help me find and fix the cause.
You may inspect and change only <vault>/.obsidian/plugins/japan-work-secretary/. If needed, read only the note I name. Do not access other plugins or notes, or change any note. Stop and ask before deleting anything.
Ask me to confirm Obsidian 1.13 or later and that I enabled Bases, then wait a few seconds for view registration. Inspect this plugin's registration and date parsing. Ask me to report the selected Deadline property, Done when checked property, Show done toggle and base filters; do not inspect or edit the base file. If needed, read only the note I name to compare its date and checkbox with my reported settings. Missing dates are omitted, and checked items are hidden unless Show done is on. Do not rewrite note properties or reset the workspace.
To confirm the fix, have me reopen the base, choose Deadlines and select its date property myself. A named, unfinished note with a valid date should appear in the correct deadline group. Have me switch Show done on and off: an already completed dated item should appear and disappear without any note being changed.
```

Still stuck? [Open an issue](https://github.com/Rexxall/japan-work-secretary/issues/new/choose).
