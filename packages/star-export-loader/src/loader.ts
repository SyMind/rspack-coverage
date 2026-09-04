import type { LoaderDefinition } from "@rspack/core";
import {
  createStarExportPlan,
  renderStarExportEntry,
  renderStarExportFacade,
} from "./transform.js";
import type { StarExportLoaderOptions, StarExportPlan } from "./types.js";

const MODE_PARAMETER = "__star_export_loader_virtual__";
const PLAN_PARAMETER = "__star_export_loader_plan__";
const compilationPlans = new WeakMap<object, Map<string, StarExportPlan>>();

type VirtualRequest =
  | { mode: "entry"; fingerprint: string }
  | { mode: "facade"; facadeId: number; fingerprint: string };

function parseVirtualRequest(resourceQuery: string): VirtualRequest | undefined {
  const parameters = new URLSearchParams(
    resourceQuery.startsWith("?") ? resourceQuery.slice(1) : "",
  );
  const mode = parameters.get(MODE_PARAMETER);
  const requestFingerprint = parameters.get(PLAN_PARAMETER);
  if (!mode && !requestFingerprint) {
    return undefined;
  }
  if (!mode || !requestFingerprint) {
    throw new Error("Malformed star-export-loader virtual module request");
  }
  if (mode === "entry") {
    return { mode, fingerprint: requestFingerprint };
  }
  if (mode.startsWith("facade:")) {
    const facadeId = Number(mode.slice("facade:".length));
    if (Number.isSafeInteger(facadeId) && facadeId >= 0) {
      return { mode: "facade", facadeId, fingerprint: requestFingerprint };
    }
  }
  throw new Error(`Unknown star-export-loader virtual module mode: ${mode}`);
}

function createVirtualRequest(
  loaderChain: string,
  resourcePath: string,
  resourceQuery: string,
  resourceFragment: string,
  planFingerprint: string,
  mode: "entry" | `facade:${number}`,
): string {
  const parameters = new URLSearchParams(
    resourceQuery.startsWith("?") ? resourceQuery.slice(1) : "",
  );
  parameters.set(MODE_PARAMETER, mode);
  parameters.set(PLAN_PARAMETER, planFingerprint);
  const resourceRequest = `${resourcePath}?${parameters.toString()}${resourceFragment}`;
  return `!!${loaderChain}!${resourceRequest}`;
}

function plansForCompilation(compilation: object): Map<string, StarExportPlan> {
  let plans = compilationPlans.get(compilation);
  if (!plans) {
    plans = new Map();
    compilationPlans.set(compilation, plans);
  }
  return plans;
}

function planCacheKey(resourcePath: string, planFingerprint: string): string {
  return `${resourcePath}\0${planFingerprint}`;
}

const starExportLoader: LoaderDefinition<StarExportLoaderOptions> = function starExportLoader(
  source,
  inputSourceMap,
) {
  this.cacheable();
  const options = this.getOptions();
  const virtualRequest = parseVirtualRequest(this.resourceQuery);
  const compilationPlanCache = plansForCompilation(this._compilation);
  const cachedPlan = virtualRequest
    ? compilationPlanCache.get(planCacheKey(this.resourcePath, virtualRequest.fingerprint))
    : undefined;
  const plan =
    cachedPlan ??
    createStarExportPlan(source, {
      ...options,
      filename: this.resourcePath,
    });
  const loaderChain = this.loaders.map((loader) => loader.request).join("!");

  if (!plan.transformed) {
    if (virtualRequest) {
      throw new Error(
        `star-export-loader could not reproduce virtual plan ${virtualRequest.fingerprint} for ${this.resourcePath}`,
      );
    }
    this.callback(null, source, inputSourceMap);
    return;
  }

  if (virtualRequest && virtualRequest.fingerprint !== plan.fingerprint) {
    throw new Error(
      `star-export-loader virtual plan mismatch for ${this.resourcePath}: expected ${virtualRequest.fingerprint}, received ${plan.fingerprint}`,
    );
  }
  compilationPlanCache.set(planCacheKey(this.resourcePath, plan.fingerprint), plan);

  const virtualEntryRequest = createVirtualRequest(
    loaderChain,
    this.resourcePath,
    this.resourceQuery,
    this.resourceFragment,
    plan.fingerprint,
    "entry",
  );

  if (virtualRequest?.mode === "entry") {
    this.callback(null, plan.virtualEntrySource, plan.virtualEntryMap);
    return;
  }

  if (virtualRequest?.mode === "facade") {
    const facade = plan.facades[virtualRequest.facadeId];
    if (!facade) {
      throw new Error(
        `star-export-loader facade ${virtualRequest.facadeId} does not exist for ${this.resourcePath}`,
      );
    }
    this.callback(null, renderStarExportFacade(facade, virtualEntryRequest));
    return;
  }

  const facadeRequests = plan.facades.map((facade) =>
    createVirtualRequest(
      loaderChain,
      this.resourcePath,
      this.resourceQuery,
      this.resourceFragment,
      plan.fingerprint,
      `facade:${facade.id}`,
    ),
  );
  this.callback(null, renderStarExportEntry(plan, virtualEntryRequest, facadeRequests));
};

export default starExportLoader;
