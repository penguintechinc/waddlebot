// Trivial spike bundle for the `waddle:bundle/stage@0.0.1-spike` world.
// Deliberately calls only `kv-get` and `log` from the world's three
// declared imports (`http-request` is left uncalled) so Q2's per-bundle
// import enumeration has something real to distinguish between "declared in
// the world" and "actually used by this bundle's generated component".
#[allow(warnings)]
mod bindings;

use bindings::waddle::bundle::host::{kv_get, log};
use bindings::Guest;

struct Component;

impl Guest for Component {
    fn transform(event: String) -> Option<String> {
        log("info", &format!("rust bundle: transform called for '{event}'"));
        match kv_get(&event) {
            Some(value) => Some(format!("{event}={value}")),
            None => {
                log("warn", &format!("rust bundle: no kv entry for '{event}'"));
                None
            }
        }
    }
}

bindings::export!(Component with_types_in bindings);
