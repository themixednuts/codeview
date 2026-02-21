/**
 * Shared pan/zoom state for SVG graph visualizations.
 * Uses Svelte 5 $state runes for granular reactivity.
 */
export class PanZoom {
	zoom = $state(1);
	panX = $state(0);
	panY = $state(0);
	isPanning = $state(false);
	isInteracting = $state(false);

	readonly minZoom: number;
	readonly maxZoom: number;

	private panStartX = 0;
	private panStartY = 0;
	private panStartPanX = 0;
	private panStartPanY = 0;

	constructor(options?: { minZoom?: number; maxZoom?: number }) {
		this.minZoom = options?.minZoom ?? 0.3;
		this.maxZoom = options?.maxZoom ?? 4;
	}

	get transform(): string {
		return `translate(${this.panX}, ${this.panY}) scale(${this.zoom})`;
	}

	handleWheel(e: WheelEvent): void {
		e.preventDefault();
		const delta = e.deltaY > 0 ? 0.9 : 1.1;
		const nextZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * delta));

		// Zoom toward cursor position
		const rect = (e.currentTarget as Element)?.getBoundingClientRect();
		if (rect) {
			const mx = e.clientX - rect.left;
			const my = e.clientY - rect.top;
			const scale = nextZoom / this.zoom;
			this.panX = mx - scale * (mx - this.panX);
			this.panY = my - scale * (my - this.panY);
		}

		this.zoom = nextZoom;
	}

	handleMouseDown(e: MouseEvent): void {
		if (e.button !== 0) return;
		this.isPanning = true;
		this.isInteracting = true;
		this.panStartX = e.clientX;
		this.panStartY = e.clientY;
		this.panStartPanX = this.panX;
		this.panStartPanY = this.panY;
	}

	handleMouseMove(e: MouseEvent): void {
		if (!this.isPanning) return;
		this.panX = this.panStartPanX + (e.clientX - this.panStartX);
		this.panY = this.panStartPanY + (e.clientY - this.panStartY);
	}

	handleMouseUp(): void {
		this.isPanning = false;
		this.isInteracting = false;
	}

	reset(): void {
		this.zoom = 1;
		this.panX = 0;
		this.panY = 0;
		this.isPanning = false;
		this.isInteracting = false;
	}

	zoomIn(): void {
		this.zoom = Math.min(this.maxZoom, this.zoom * 1.2);
	}

	zoomOut(): void {
		this.zoom = Math.max(this.minZoom, this.zoom / 1.2);
	}
}
