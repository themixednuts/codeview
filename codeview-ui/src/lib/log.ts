import { configure, getConsoleSink, getLogger as _getLogger } from '@logtape/logtape';

let configured = false;

const isBrowser = typeof globalThis.document !== 'undefined';

function isPerfEnabled(): boolean {
	if (!isBrowser) return false;
	try {
		if (new URL(window.location.href).searchParams.has('perf')) return true;
	} catch {}
	try {
		if (localStorage.getItem('codeview-perf') === '1') return true;
	} catch {}
	return false;
}

export async function setupLogging(): Promise<void> {
	if (configured) return;
	configured = true;

	const perfEnabled = isPerfEnabled();

	await configure({
		sinks: {
			console: getConsoleSink({
				formatter: (record) => {
					const cat = record.category.slice(1).join(':');
					const prefix = `[${cat}]`;
					const msg = record.message.map((p) => (typeof p === 'function' ? p() : p)).join('');
					return [`${prefix} ${msg}`];
				}
			})
		},
		loggers: [
			{
				category: ['logtape', 'meta'],
				sinks: []
			},
			{
				category: ['codeview', 'perf'],
				sinks: perfEnabled ? ['console'] : [],
				parentSinks: 'override',
				lowestLevel: 'debug'
			},
			{
				category: ['codeview'],
				sinks: ['console'],
				lowestLevel: 'debug'
			}
		]
	});
}

export function getLogger(...category: string[]) {
	return _getLogger(['codeview', ...category]);
}

export function getPerfLogger(category: string) {
	return _getLogger(['codeview', 'perf', category]);
}
