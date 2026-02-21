import { getPerfLogger } from './log';

type DetailFn<T> = string | ((result: T) => string);

const perfNow = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());
const raf =
	typeof requestAnimationFrame === 'function'
		? requestAnimationFrame
		: (cb: (time: number) => void) => setTimeout(() => cb(perfNow()), 16);

function resolveDetail<T>(detail: DetailFn<T> | undefined, result: T): string {
	if (!detail) return '';
	if (typeof detail === 'string') return detail;
	return detail(result);
}

function formatMsg(label: string, dt: number, detail?: string): string {
	const suffix = detail ? ` (${detail})` : '';
	return `${label} ${dt.toFixed(1)}ms${suffix}`;
}

export const perf = {
	time<T>(
		cat: string,
		label: string,
		fn: () => T,
		opts?: { threshold?: number; detail?: DetailFn<T> },
	): T {
		const t0 = perfNow();
		const result = fn();
		const dt = perfNow() - t0;
		const threshold = opts?.threshold ?? 2;
		if (dt > threshold) {
			getPerfLogger(cat).debug(formatMsg(label, dt, resolveDetail(opts?.detail, result)));
		}
		return result;
	},

	async timeAsync<T>(
		cat: string,
		label: string,
		fn: () => Promise<T>,
		opts?: { threshold?: number; detail?: DetailFn<T> },
	): Promise<T> {
		const t0 = perfNow();
		const result = await fn();
		const dt = perfNow() - t0;
		const threshold = opts?.threshold ?? 2;
		if (dt > threshold) {
			getPerfLogger(cat).debug(formatMsg(label, dt, resolveDetail(opts?.detail, result)));
		}
		return result;
	},

	timeAlways<T>(cat: string, label: string, fn: () => T, opts?: { detail?: DetailFn<T> }): T {
		const t0 = perfNow();
		const result = fn();
		const dt = perfNow() - t0;
		getPerfLogger(cat).debug(formatMsg(label, dt, resolveDetail(opts?.detail, result)));
		return result;
	},

	begin(cat: string, label: string): { end: () => void } {
		const t0 = perfNow();
		const logger = getPerfLogger(cat);
		logger.debug(`${label} start`);
		return {
			end() {
				const dt = perfNow() - t0;
				logger.debug(`${label} ${dt.toFixed(0)}ms`);
			},
		};
	},

	/** Log a one-shot event (no timing, just a message). */
	event(cat: string, label: string, detail?: string): void {
		const suffix = detail ? ` (${detail})` : '';
		getPerfLogger(cat).debug(`${label}${suffix}`);
	},

	frame<T>(cat: string, label: string, fn: () => T): T {
		const t0 = perfNow();
		const result = fn();
		const dt = perfNow() - t0;

		// Accumulate into per-label frame counter
		let entry = _frameCounters.get(label);
		if (!entry) {
			entry = { count: 0, totalMs: 0, scheduled: false };
			_frameCounters.set(label, entry);
		}
		entry.count++;
		entry.totalMs += dt;

		if (!entry.scheduled) {
			entry.scheduled = true;
			raf(() => {
				const logger = getPerfLogger(cat);
				logger.debug(
					`${label} recomputed ${entry!.count}x this frame (${entry!.totalMs.toFixed(1)}ms total)`,
				);
				entry!.count = 0;
				entry!.totalMs = 0;
				entry!.scheduled = false;
			});
		}

		return result;
	},
};

const _frameCounters = new Map<string, { count: number; totalMs: number; scheduled: boolean }>();
