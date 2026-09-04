import { describe, expect, test } from "vitest";
import {
  createStarExportPlan,
  renderStarExportEntry,
  renderStarExportFacade,
} from "../../src/transform.js";

const THREE_RUNTIME_SOURCE = `
const foo = foo_fn();
const bar = bar_fn();

// rolldown
var lib_rolldown = /* @__PURE__ */ __exportAll({ fooRolldown: foo, barRolldown: bar });

// rollup
var lib_rollup = /*#__PURE__*/ Object.freeze({
  __proto__: null,
  barRollup: bar,
  get fooRollup() { return foo; }
});

// esbuild
var lib_exports = {};
__export(lib_exports, {
  barEsbuild: () => bar,
  fooEsbuild: () => foo
});

const untouched = 42;
export { lib_rollup, lib_exports as lib_esbuild, lib_rolldown, untouched };
`;

describe("createStarExportPlan", () => {
  test("splits Rollup, esbuild, and Rolldown runtimes into one implementation and three facades", () => {
    const plan = createStarExportPlan(THREE_RUNTIME_SOURCE, { filename: "library.js" });

    expect(plan.transformed).toBe(true);
    expect(plan.virtualEntryMap?.file).toBe("library.js");
    expect(plan.facades.map((facade) => facade.adapter)).toEqual(["rollup", "esbuild", "rolldown"]);
    expect(plan.remainingExports).toEqual(["untouched"]);
    expect(plan.virtualEntrySource).not.toContain("Object.freeze");
    expect(plan.virtualEntrySource).not.toContain("__export(lib_exports");
    expect(plan.virtualEntrySource).not.toContain("__exportAll({");
    expect(plan.virtualEntrySource).not.toContain("export { lib_rollup");
    expect(plan.virtualEntrySource).toContain("foo as fooRollup");
    expect(plan.virtualEntrySource).toContain("bar as barEsbuild");

    const facadeRequests = plan.facades.map((facade) => `virtual:facade-${facade.id}`);
    const entry = renderStarExportEntry(plan, "virtual:entry", facadeRequests);
    expect(entry).toContain('export * as lib_rollup from "virtual:facade-');
    expect(entry).toContain('export * as lib_esbuild from "virtual:facade-');
    expect(entry).toContain('export * as lib_rolldown from "virtual:facade-');
    expect(entry).toContain('export { untouched } from "virtual:entry";');

    for (const facade of plan.facades) {
      const source = renderStarExportFacade(facade, "virtual:entry");
      expect(source).toContain('from "virtual:entry";');
      expect(source).not.toContain(facade.namespaceLocal);
    }
  });

  test("uses an internal alias when two namespace facades expose different bindings under one name", () => {
    const plan = createStarExportPlan(`
      const first = 1;
      const second = 2;
      const firstNs = Object.freeze({ __proto__: null, value: first });
      const secondNs = Object.freeze({ __proto__: null, value: second });
      export { firstNs, secondNs };
    `);

    expect(plan.transformed).toBe(true);
    expect(plan.facades[0]?.members[0]?.virtualExportName).toBe("value");
    expect(plan.facades[1]?.members[0]?.virtualExportName).toMatch(/^__star_export_/);
    const secondFacade = plan.facades[1];
    if (!secondFacade) {
      throw new Error("Expected the second namespace facade");
    }
    expect(renderStarExportFacade(secondFacade, "virtual:entry")).toMatch(
      /__star_export_\d+ as value/,
    );
  });

  test("reuses a remaining public export when it already points to the facade binding", () => {
    const plan = createStarExportPlan(`
      const value = 1;
      const library = __exportAll({ value: () => value });
      export { value, library };
    `);

    expect(plan.transformed).toBe(true);
    expect(plan.facades[0]?.members[0]?.virtualExportName).toBe("value");
    expect(plan.virtualEntrySource).not.toContain("__star_export_");
    expect(plan.virtualEntrySource.match(/export \{ value \}/g)).toHaveLength(1);
  });

  test("recognizes a minified esbuild helper by structure instead of its identifier", () => {
    const plan = createStarExportPlan(`
      var d = Object.defineProperty;
      var h = (target, all) => { for (var key in all) d(target, key, { get: all[key], enumerable: !0 }); };
      const foo = 1;
      var library = {};
      h(library, { foo: () => foo });
      export { library };
    `);

    expect(plan.transformed).toBe(true);
    expect(plan.facades).toHaveLength(1);
    expect(plan.facades[0]?.adapter).toBe("esbuild");
  });

  test("recognizes the getter map emitted by current Rolldown", () => {
    const plan = createStarExportPlan(`
      import { t as __exportAll } from "./rolldown-runtime.js";
      const foo = 1;
      const bar = 2;
      const library = /* @__PURE__ */ __exportAll({
        foo: () => foo,
        renamed: () => bar,
      });
      export { library };
    `);

    expect(plan.transformed).toBe(true);
    expect(plan.facades).toHaveLength(1);
    expect(plan.facades[0]).toMatchObject({
      adapter: "rolldown",
      namespaceExports: ["library"],
      members: [
        expect.objectContaining({ exportedName: "foo", localName: "foo" }),
        expect.objectContaining({ exportedName: "renamed", localName: "bar" }),
      ],
    });
  });

  test("does not merge an esbuild-like loop from a nested function into the helper scope", () => {
    const plan = createStarExportPlan(`
      var d = Object.defineProperty;
      var h = (target, all) => () => {
        for (var key in all) d(target, key, { get: all[key], enumerable: true });
      };
      const foo = 1;
      var library = {};
      h(library, { foo: () => foo });
      export { library };
    `);

    expect(plan.transformed).toBe(false);
  });

  test("recognizes Rollup's optional module toStringTag wrapper", () => {
    const plan = createStarExportPlan(`
      const foo = 1;
      const library = Object.freeze(Object.defineProperty({
        __proto__: null,
        foo
      }, Symbol.toStringTag, { value: "Module" }));
      export { library };
    `);

    expect(plan.transformed).toBe(true);
    expect(plan.facades[0]?.adapter).toBe("rollup");
  });

  test("keeps a runtime unchanged when its namespace object is observed internally", () => {
    const source = `
      const foo = 1;
      const library = Object.freeze({ __proto__: null, foo });
      inspect(library);
      export { library };
    `;
    const plan = createStarExportPlan(source);

    expect(plan.transformed).toBe(false);
    expect(plan.virtualEntrySource).toBe(source);
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({ code: "unexpected-namespace-reference" }),
    );
  });

  test("does not mistake a normal frozen object for a Rollup namespace", () => {
    const source = `
      const foo = 1;
      const config = Object.freeze({ foo });
      export { config };
    `;
    expect(createStarExportPlan(source).transformed).toBe(false);
  });

  test("does not rewrite Object.freeze when Object is shadowed", () => {
    const source = `
      const Object = { freeze: (value) => value };
      const foo = 1;
      const library = Object.freeze({ __proto__: null, foo });
      export { library };
    `;
    expect(createStarExportPlan(source).transformed).toBe(false);
  });

  test("fails closed when an unbounded export star could leak promoted members", () => {
    const source = `
      const foo = 1;
      const library = Object.freeze({ __proto__: null, foo });
      export { library };
      export * from "./other.js";
    `;
    const plan = createStarExportPlan(source);

    expect(plan.transformed).toBe(false);
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({ code: "unbounded-export-star" }),
    );
  });
});
