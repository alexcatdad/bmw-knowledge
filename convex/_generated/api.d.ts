/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as acquisition from "../acquisition.js";
import type * as collection from "../collection.js";
import type * as collectionExecution from "../collectionExecution.js";
import type * as corpus from "../corpus.js";
import type * as digests from "../digests.js";
import type * as http from "../http.js";
import type * as processing from "../processing.js";
import type * as processingHttp from "../processingHttp.js";
import type * as research from "../research.js";
import type * as researchHttp from "../researchHttp.js";
import type * as researchSecurity from "../researchSecurity.js";
import type * as researchValidators from "../researchValidators.js";
import type * as sourceSearch from "../sourceSearch.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  acquisition: typeof acquisition;
  collection: typeof collection;
  collectionExecution: typeof collectionExecution;
  corpus: typeof corpus;
  digests: typeof digests;
  http: typeof http;
  processing: typeof processing;
  processingHttp: typeof processingHttp;
  research: typeof research;
  researchHttp: typeof researchHttp;
  researchSecurity: typeof researchSecurity;
  researchValidators: typeof researchValidators;
  sourceSearch: typeof sourceSearch;
  validators: typeof validators;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
