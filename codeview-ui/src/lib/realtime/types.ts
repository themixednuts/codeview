export type RealtimeCallback<T = unknown> = (data: T) => void;

export interface RealtimeClient {
	subscribe<T = unknown>(tag: string, callback: RealtimeCallback<T>): void | Promise<void>;
	unsubscribe<T = unknown>(tag: string, callback: RealtimeCallback<T>): void | Promise<void>;
	isSubscribed(tag: string): boolean;
}
