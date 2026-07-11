import { APP_VERSION } from "./version";

export const manifest = {
  id: "com.autostream.addon",
  version: APP_VERSION,
  name: "AutoStream",
  description: "One stream. No choosing. Smart automatic stream selection.",
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
