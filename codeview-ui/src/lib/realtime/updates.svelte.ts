import { getLogger } from "#lib/log.js";
import { connect } from "$realtime";
import type { RealtimeClient } from "./types";
import * as Predicate from "effect/Predicate";
import type { Json } from "effect/Schema";

const CONNECT_DELAY_MS = 1_500;

export class CrossEdgeUpdatesConnection implements Disposable {
  updateTick = $state(0);

  #client: RealtimeClient = connect();
  #log = getLogger("graph-updates");
  #nodeId = "";
  #currentTag: string | null = null;
  #unsubscribe: (() => void) | null = null;
  #connectTimer: ReturnType<typeof setTimeout> | null = null;

  get tag() {
    return `edge:${this.#nodeId}`;
  }

  connect(nodeId: string) {
    if (this.#nodeId === nodeId && this.#currentTag) return;
    this.#cancelPending();
    this.disconnect();

    this.#nodeId = nodeId;
    const tag = `edge:${nodeId}`;
    this.#currentTag = tag;

    this.#log.debug`connect ${this.tag}`;

    this.#connectTimer = setTimeout(() => {
      this.#connectTimer = null;
      void this.#doSubscribe(tag);
    }, CONNECT_DELAY_MS);
  }

  async #doSubscribe(tag: string) {
    const callback = (data: Json) => this.#onData(data);
    await this.#client.subscribe(tag, callback);
    this.#unsubscribe = () => {
      void this.#client.unsubscribe(tag, callback);
    };
  }

  #cancelPending() {
    if (this.#connectTimer !== null) {
      clearTimeout(this.#connectTimer);
      this.#connectTimer = null;
    }
  }

  disconnect() {
    this.#cancelPending();
    if (this.#unsubscribe) {
      this.#unsubscribe();
      this.#unsubscribe = null;
    }
    this.#currentTag = null;
  }

  #onData(data: Json) {
    if (!Predicate.isObject(data)) return;
    const type = "type" in data && Predicate.isString(data.type) ? data.type : undefined;
    if (type && type !== "cross-edges") return;
    this.updateTick += 1;
    this.#log.debug`update ${this.tag} tick=${String(this.updateTick)}`;
  }

  destroy() {
    this.disconnect();
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}
