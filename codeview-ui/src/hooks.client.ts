import type { HandleClientError } from "@sveltejs/kit/hooks";
import { getLogger, setupLogging } from "#lib/log.js";

const log = getLogger("client-hooks");

export async function init() {
  await setupLogging();
}

export const handleError: HandleClientError = (input) => {
  const { event, kind, error } = input;
  switch (kind) {
    case "framework":
      log.error`navigation error status=${String(error.status)} url=${event.url.toString()} message=${error.message} error=${String(error)}`;
      return { message: error.message };
    case "app":
      log.error`navigation error url=${event.url.toString()} error=${String(error)}`;
      return error;
    case "unknown":
      log.error`navigation error url=${event.url.toString()} error=${String(error)}`;
      return { message: "Internal Error" };
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
};
