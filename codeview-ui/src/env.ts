import { defineEnvVars } from "@sveltejs/kit/env";

export const variables = defineEnvVars({
  PUBLIC_CODEVIEW_PLATFORM: {
    public: true,
    static: true,
    schema: (value: string | undefined) => value ?? "local",
    description: "Build-time platform: local sidecar or hosted Cloudflare",
  },
});
