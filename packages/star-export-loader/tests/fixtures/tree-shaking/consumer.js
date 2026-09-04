import {
  evaluationCount,
  lib_esbuild,
  lib_rolldown,
  lib_rollup,
  untouched,
} from "./runtime-library.js";

export const result = [
  lib_rollup.fooRollup,
  lib_esbuild.fooEsbuild,
  lib_rolldown.fooRolldown,
  untouched,
  evaluationCount,
];
