export const STEP_ORDER = ['resolving', 'fetching', 'parsing', 'finalizing', 'storing', 'indexing'];

export const stepLabels: Record<string, string> = {
	resolving: 'Resolving metadata...',
	fetching: 'Downloading rustdoc...',
	parsing: 'Extracting graph...',
	finalizing: 'Resolving edges...',
	storing: 'Uploading graph...',
	indexing: 'Indexing dependencies...',
};

export const stepPercents: Record<string, number> = {
	resolving: 5,
	fetching: 10,
	parsing: 15,
	finalizing: 60,
	storing: 85,
	indexing: 92,
};
