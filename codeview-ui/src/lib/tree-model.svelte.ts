import type { CrateTree } from '$lib/schema';

type TreeSource = 'empty' | 'query' | 'stream';

/**
 * Single canonical tree model for crate view.
 *
 * Query data and stream data both feed this same model.
 * The UI consumes only this model, never alternate tree sources.
 */
export class TreeModel {
	tree = $state<CrateTree | null>(null);
	source = $state<TreeSource>('empty');
	sequence = $state<number | null>(null);
	contentId = $state<string | null>(null);
	version = $state(0);

	clear() {
		if (this.tree === null && this.source === 'empty' && this.sequence === null && this.contentId === null) {
			return;
		}
		this.tree = null;
		this.source = 'empty';
		this.sequence = null;
		this.contentId = null;
		this.version += 1;
	}

	applyQuerySnapshot(tree: CrateTree) {
		if (this.tree === tree && this.source === 'query') return;
		this.tree = tree;
		this.source = 'query';
		this.sequence = null;
		this.contentId = null;
		this.version += 1;
	}

	applyStreamTree(tree: CrateTree, sequence: number | null, contentId: string | null) {
		const unchanged = this.tree === tree
			&& this.source === 'stream'
			&& this.sequence === sequence
			&& this.contentId === contentId;
		if (unchanged) return;
		this.tree = tree;
		this.source = 'stream';
		this.sequence = sequence;
		this.contentId = contentId;
		this.version += 1;
	}
}
