export const STEP_ORDER = ['resolving', 'fetching', 'parsing', 'storing', 'indexing'];

export const stepLabels: Record<string, string> = {
	resolving: 'Resolving metadata...',
	fetching: 'Downloading rustdoc...',
	parsing: 'Extracting graph...',
	storing: 'Uploading graph...',
	indexing: 'Indexing dependencies...',
};

export const stepPercents: Record<string, number> = {
	resolving: 5,
	fetching: 10,
	parsing: 15,
	storing: 85,
	indexing: 92,
};
