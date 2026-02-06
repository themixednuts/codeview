import { query } from "$app/server";
import { NodeDetailInputSchema, type NodeDetail } from "$lib/schema";
import {
  getProvider,
  resolveNodeDetail,
  type NodeDetailInput,
} from "./helpers";

/** Get full node detail + all edges (for the detail panel) */
export const getNodeDetail = query.batch(
  NodeDetailInputSchema,
  async (
    inputs,
  ): Promise<(input: NodeDetailInput, index: number) => NodeDetail | null> => {
    const provider = await getProvider();
    const workspace = await provider.loadWorkspace();
    const results = await Promise.all(
      inputs.map((input) => resolveNodeDetail(input, provider, workspace)),
    );
    return (_input, index) => results[index] ?? null;
  },
);
