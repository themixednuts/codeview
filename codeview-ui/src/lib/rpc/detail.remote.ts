import { query } from "$app/server";
import * as Effect from "effect/Effect";
import type { NodeDetail } from "#lib/schema.js";
import { loader, resolve, type NodeDetailInput } from "./helpers";
import { NodeDetailInputSchema } from "./schemas";

/** Get full node detail + all edges (for the detail panel) */
export const getNodeDetail = query.batch(
  NodeDetailInputSchema,
  async (inputs): Promise<(input: NodeDetailInput, index: number) => NodeDetail | null> => {
    const provider = await loader.provider();
    const workspace = await loader.localWorkspace(provider);
    const results = await Effect.runPromise(
      Effect.forEach(
        inputs,
        (input) => Effect.promise(() => resolve.nodeDetail(input, provider, workspace)),
        { concurrency: 8 },
      ),
    );
    return (_input, index) => results[index] ?? null;
  },
);
