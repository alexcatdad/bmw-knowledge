import { httpRouter } from "convex/server";
import { result } from "./processingHttp";

const http = httpRouter();
http.route({ path: "/processing/result", method: "POST", handler: result });
export default http;
