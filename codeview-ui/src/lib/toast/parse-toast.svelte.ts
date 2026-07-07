export const parseToastState = $state({
	active: false,
	crateName: '',
	version: '',
	step: null as string | null,
	nodeCount: 0,
	edgeCount: 0,
	totalItems: null as number | null,
});

export const parseToastTarget = $state({
	active: false,
	crateName: '',
	version: '',
});

export function showParseToastTarget(crateName: string, version: string) {
	parseToastTarget.active = true;
	parseToastTarget.crateName = crateName;
	parseToastTarget.version = version;
}

export function clearParseToastTarget(crateName?: string, version?: string) {
	if (crateName && parseToastTarget.crateName !== crateName) return;
	if (version && parseToastTarget.version !== version) return;
	parseToastTarget.active = false;
	parseToastTarget.crateName = '';
	parseToastTarget.version = '';
}
