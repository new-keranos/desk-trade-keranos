// Lets `node --experimental-strip-types` load the app's extensionless relative imports ("./pivots") in tests.
import { registerHooks } from "node:module";
registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx); } catch (err) {
      if (spec.startsWith(".") && !/\.[cm]?[jt]s$/.test(spec)) return next(spec + ".ts", ctx);
      throw err;
    }
  },
});
