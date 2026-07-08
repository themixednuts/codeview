export const STEP_ORDER = [
	'queued',
	'waiting-capacity',
	'waiting-github-capacity',
	'waiting-rate-limit',
	'workflow-started',
	'github-running',
	'resolving',
	'fetching',
	'parsing',
	'finalizing',
	'storing',
	'indexing',
];

export const stepLabels: Record<string, string> = {
	queued: 'Queued...',
	'waiting-capacity': 'Waiting for parser capacity...',
	'waiting-github-capacity': 'Waiting for parser capacity...',
	'waiting-rate-limit': 'Waiting for parser capacity...',
	'workflow-started': 'Starting parser workflow...',
	'github-running': 'Running parser job...',
	resolving: 'Resolving metadata...',
	fetching: 'Downloading rustdoc...',
	parsing: 'Extracting graph...',
	finalizing: 'Resolving edges...',
	storing: 'Uploading graph...',
	indexing: 'Indexing dependencies...',
};

export const stepPercents: Record<string, number> = {
	queued: 2,
	'waiting-capacity': 3,
	'waiting-github-capacity': 3,
	'waiting-rate-limit': 3,
	'workflow-started': 5,
	'github-running': 8,
	resolving: 5,
	fetching: 10,
	parsing: 15,
	finalizing: 60,
	storing: 85,
	indexing: 92,
};
