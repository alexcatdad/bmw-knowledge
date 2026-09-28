import { httpRouter } from "convex/server";
import { result } from "./processingHttp";
import { mcp } from "./researchHttp";

const http = httpRouter();
http.route({ path: "/processing/result", method: "POST", handler: result });
http.route({ path: "/mcp", method: "POST", handler: mcp });
http.route({ path: "/mcp", method: "GET", handler: mcp });
http.route({ path: "/mcp", method: "DELETE", handler: mcp });
export default http;
