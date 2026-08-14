import { getLogger } from "#lib/log.js";
import { connect } from "$realtime";
import type { RealtimeClient } from "./types";
import * as Predicate from "effect/Predicate";
import type { Json } from "effect/Schema";

export class ParseProgressConnection implements Disposable {
  nodeCount = $state(0);
  edgeCount = $state(0);
  totalItems = $state<number | null>(null);
  complete: boolean = $state(false);

  #client: RealtimeClient = connect();
  #log = getLogger("progress");
  #name = "";
  #version = "";
  #currentTag: string | null = null;
  #callback = (data: Json) => this.#onProgressData(data);

  get tag() {
    return `${this.#name}@${this.#version}`;
  }

  connect(name: string, version: string) {
    this.reset();
    this.#name = name;
    this.#version = version;
    const tag = `progress:rust:${name}:${version}`;
    this.#currentTag = tag;

    this.#log.debug`connect ${this.tag}`;

    this.#client.subscribe(tag, this.#callback);
  }

  disconnect() {
    if (this.#currentTag) {
      this.#client.unsubscribe(this.#currentTag, this.#callback);
      this.#currentTag = null;
    }
  }

  destroy() {
    this.disconnect();
    this.#resetCounters();
  }

  [Symbol.dispose]() {
    this.destroy();
  }

  reset() {
    this.disconnect();
    this.#resetCounters();
  }

  #resetCounters() {
    this.nodeCount = 0;
    this.edgeCount = 0;
    this.totalItems = null;
    this.complete = false;
  }

  #onProgressData(data: Json) {
    if (!Predicate.isObject(data)) return;
    const type = "type" in data && Predicate.isString(data.type) ? data.type : undefined;
    const nodeCount =
      "nodeCount" in data && Predicate.isNumber(data.nodeCount) ? data.nodeCount : undefined;
    const edgeCount =
      "edgeCount" in data && Predicate.isNumber(data.edgeCount) ? data.edgeCount : undefined;
    const totalItems =
      "totalItems" in data && Predicate.isNumber(data.totalItems) ? data.totalItems : undefined;

    this.#log
      .debug`msg ${this.tag} type=${type ?? "-"} nodes=${nodeCount ?? 0} edges=${edgeCount ?? 0} total=${totalItems ?? "-"}`;

    if (nodeCount !== undefined) this.nodeCount = nodeCount;
    if (edgeCount !== undefined) this.edgeCount = edgeCount;

    if ((type === "meta" || type === "complete") && totalItems !== undefined) {
      this.totalItems = totalItems;
    }

    if (type === "complete") {
      this.complete = true;
      this.#log.debug`complete ${this.tag}`;
      this.disconnect();
    }
  }
}
