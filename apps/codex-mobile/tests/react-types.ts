// Resolve UI test types from the app's own dependencies, just like appRequire.
export type ReactApi = typeof import("react");
export type ReactServerApi = typeof import("react-dom/server");
export type { ComponentType } from "react";
