import type { WebsiteEnv } from "../alchemy.run.ts";
import type { AuthSession, AuthState, AuthUser } from "#lib/server/auth.js";
import type { CrateMapData } from "#lib/graph/crate-map.js";
import type { NodeView } from "#lib/schema.js";

declare global {
  namespace App {
    interface Locals {
      auth: AuthState;
      user: AuthUser | null;
      session: AuthSession | null;
    }

    interface PageData {
      nodeView?: NodeView | null;
      crateMap?: CrateMapData | null;
      nodeId?: string;
    }

    interface Platform {
      env?: WebsiteEnv;
      server?: {
        upgrade(request: Request, options?: { data?: unknown }): boolean;
      };
    }
  }
}

declare module "$app/env/public" {
  export const PUBLIC_CODEVIEW_PLATFORM: string;
}

export {};
