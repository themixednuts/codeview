import { getLogger } from "#lib/log.js";
import { connect } from "$realtime";
import type { CrateSummaryResult } from "#lib/server/provider.js";
import type { RealtimeClient } from "./types";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export class ProcessingStatusConnection implements Disposable {
  count = $state(0);
  crates = $state.raw<CrateSummaryResult[]>([]);

  #client: RealtimeClient = connect();
  #log = getLogger("processing");
  #ecosystem = "rust";
  #currentTag: string | null = null;
  #callback = (data: Schema.Json) => this.#onData(data);

  get tag() {
    return `processing:${this.#ecosystem}`;
  }

  connect(ecosystem = "rust") {
    if (this.#ecosystem === ecosystem && this.#currentTag) return;
    this.disconnect();

    this.#ecosystem = ecosystem;
    const tag = `processing:${ecosystem}`;
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

  #onData(data: Schema.Json) {
    if (!Predicate.isObject(data)) return;
    const type = "type" in data && Predicate.isString(data.type) ? data.type : undefined;
    if (type && type !== "processing") return;
    if ("count" in data && Predicate.isNumber(data.count)) {
      this.#log.debug`msg ${this.tag} count=${String(data.count)}`;
      this.count = data.count;
    }
    if ("crates" in data && Array.isArray(data.crates)) {
      this.crates = [
        ...(Option.getOrUndefined(
          Schema.decodeUnknownOption(Schema.Array(CrateSummarySchema))(data.crates),
        ) ?? []),
      ];
    }
  }

  destroy() {
    this.disconnect();
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}

const CrateSummarySchema = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  id: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
});
