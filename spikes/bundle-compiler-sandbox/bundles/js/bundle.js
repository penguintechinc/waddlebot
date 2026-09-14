// Trivial spike bundle for the `waddle:bundle/stage@0.0.1-spike` world.
// Calls only `http-request` and `log` from the world's three declared
// imports (`kv-get` is left uncalled) -- see bundles/rust and bundles/python
// for the other two import subsets exercised by this spike.
import { httpRequest, log } from "waddle:bundle/host@0.0.1-spike";

export function transform(event) {
  log("info", `js bundle: transform called for '${event}'`);
  const response = httpRequest(event);
  return response.length > 0 ? response : undefined;
}
