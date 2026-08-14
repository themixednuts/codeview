import type { Json } from "effect/Schema";

export type RealtimeCallback = (data: Json) => void;

export interface RealtimeClient {
  subscribe(tag: string, callback: RealtimeCallback): void | Promise<void>;
  unsubscribe(tag: string, callback: RealtimeCallback): void | Promise<void>;
  isSubscribed(tag: string): boolean;
}
