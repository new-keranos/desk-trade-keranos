// Lets `node --experimental-strip-types` load the app's extensionless relative imports ("./pivots") and the
// "@/" path alias in tests.
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
const root = pathToFileURL(new URL("..", import.meta.url).pathname).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) spec = root + spec.slice(2);
    try { return next(spec, ctx); } catch (err) {
      if ((spec.startsWith(".") || spec.startsWith("file:")) && !/\.[cm]?[jt]sx?$/.test(spec)) return next(spec + ".ts", ctx);
      throw err;
    }
  },
});
