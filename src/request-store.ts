import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "./env";

export interface RequestStore {
  env: Env;
  openId: string;
}

export const requestContext = new AsyncLocalStorage<RequestStore>();
