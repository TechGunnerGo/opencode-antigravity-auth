export {
  AntigravityCLIOAuthPlugin,
  GoogleOAuthPlugin,
} from "./src/plugin.ts";

export {
  authorizeAntigravity,
  exchangeAntigravity,
} from "./src/antigravity/oauth.ts";

export type {
  AntigravityAuthorization,
  AntigravityTokenExchangeResult,
} from "./src/antigravity/oauth.ts";
import { AntigravityV2Plugin } from "./src/plugin-v2.ts"
import { AntigravityCLIOAuthPlugin } from "./src/plugin.ts"

export default {
  ...AntigravityV2Plugin,
  server: AntigravityCLIOAuthPlugin,
}
