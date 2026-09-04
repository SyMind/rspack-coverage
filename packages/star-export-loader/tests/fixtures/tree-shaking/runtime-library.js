const foo = "STAR_EXPORT_FOO";
const bar = "STAR_EXPORT_BAR_SHOULD_DISAPPEAR";
const evaluationCount = (globalThis.__STAR_EXPORT_EVALUATION_COUNT__ ?? 0) + 1;
globalThis.__STAR_EXPORT_EVALUATION_COUNT__ = evaluationCount;

var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all) {
    __defProp(target, name, { get: all[name], enumerable: true });
  }
};
var __exportAll = (all, no_symbols) => {
  const target = {};
  for (var name in all) {
    __defProp(target, name, { get: all[name], enumerable: true });
  }
  if (!no_symbols) {
    __defProp(target, Symbol.toStringTag, { value: "Module" });
  }
  return target;
};

var lib_rolldown = /* @__PURE__ */ __exportAll({
  fooRolldown: () => foo,
  barRolldown: () => bar,
});

var lib_rollup = /* @__PURE__ */ Object.freeze({
  __proto__: null,
  barRollup: bar,
  fooRollup: foo,
});

var lib_exports = {};
__export(lib_exports, {
  barEsbuild: () => bar,
  fooEsbuild: () => foo,
});

const untouched = "STAR_EXPORT_UNTOUCHED";

export { evaluationCount, lib_exports as lib_esbuild, lib_rolldown, lib_rollup, untouched };
