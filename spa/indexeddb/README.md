# Preserved IndexedDB baseline

This is the former SPA controller and layout, kept for comparison with the
new JSPI application. It still uses `ffi` and `multipleciphers-relaxed-idb`.
Only the generated module import path and obsolete classic-script tag changed.

Build with `make spa-indexeddb`; serve with `make serve-spa-indexeddb` on port 8082.
To access existing IndexedDB data, serve `spa/out-indexeddb` on its original
scheme/host/port instead. Origin changes do not migrate browser data.
The original encryption conversion/removal controls belong only to this baseline.
