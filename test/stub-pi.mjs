// Registers a resolve hook that maps @earendil-works/pi-coding-agent to a stub
// so the extension can be imported/tested without pi installed.
import { register } from "node:module";
register(new URL("./pi-resolver.mjs", import.meta.url));
