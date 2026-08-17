export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@earendil-works/pi-coding-agent") {
    return { url: new URL("./pi-stub.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
