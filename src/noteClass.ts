/** The classes in a note's cssclasses (or the old cssclass field) plus the plugin's note class, each once. */
export function mergeCssClasses(raw: unknown, cssClass: string | undefined): string[] {
	const list = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [])
		.map(value => String(value).trim())
		.filter(Boolean);
	const name = (cssClass ?? '').trim();
	if (/^[A-Za-z][\w-]*$/.test(name) && !list.includes(name)) list.push(name);
	return [...new Set(list)];
}
