import { APP_VERSION } from "./version";

export const manifest = {
  id: "com.autostream.addon",
  version: APP_VERSION,
  name: "AutoStream",
  description: "One stream. No choosing. Smart automatic stream selection.",
  logo: "/icon.png",
  background: "/logo.png",
  behaviorHints: {
    configurable: true,
    p2p: true
  },
  resources: [
    "stream"
  ],
  types: [
    "movie",
    "series"
  ],
  catalogs: [],
  idPrefixes: [
    "tt"
  ]
};
