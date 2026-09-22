SHELL := /usr/bin/env bash

# Default goal
.DEFAULT_GOAL := help

.PHONY: help
# Parse the comment starting with a double ## next to a target as the target description
# in the help message
help: ## Show this help message
	@grep -E '^[a-zA-Z0-9_.-]+:.*?## ' $(MAKEFILE_LIST) | \
		sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-25s\033[0m %s\n", $$1, $$2}'


# wasm-pack build ffi --target web
# cp ffi/pkg/*.js ffi/pkg/*.d.ts ffi/pkg/*.wasm spa
# bun build spa/index.html --outdir spa/out --target browser
# cp ffi/pkg/*.wasm spa/out/

CRATES := todo-list ffi 
CRATE_MANIFESTS := $(addsuffix /Cargo.toml,$(CRATES))
WORKSPACE_CARGO_FILES := Cargo.toml Cargo.lock
RUST_RS_FILES := $(shell find $(CRATES) \
	\( -type d -name rust_modules -o -type d -name node_modules \) -prune \
	-o -type f -name '*.rs' -print 2>/dev/null | LC_ALL=C sort)
RUST_SOURCES := $(WORKSPACE_CARGO_FILES) $(CRATE_MANIFESTS) $(RUST_RS_FILES) todo-list/src/schema/schema.sql

PKG_DIR := ffi/pkg/
COMPILED_WASM := ffi_bg.wasm ffi.js 
PKG_OUT := $(addprefix $(PKG_DIR),$(COMPILED_WASM))
FFI_D_TS := ffi/pkg/ffi.d.ts

$(PKG_OUT) $(FFI_D_TS) &: $(RUST_SOURCES)
	wasm-pack build ffi --target web

# The default SPA uses the same pinned encryption build as the validated probe.
# Always build: generated WASM/glue/snippets must come from the same invocation.
.PHONY: spa spa-check serve-spa clean-spa spa-indexeddb serve-spa-indexeddb spa-zip
spa: jspi-encryption ## build the encrypted JSPI/OPFS application
	bun run spa/build.ts

spa-check: spa ## typecheck the SPA and run adapter tests
	tsc -p spa/tsconfig.json
	bun test spa/backend.test.ts

serve-spa: spa ## serve encrypted JSPI app on 127.0.0.1:8080
	miniserve --interfaces 127.0.0.1 --port 8080 --index index.html spa/out

spa-indexeddb: $(PKG_OUT) $(FFI_D_TS) ## build the preserved IndexedDB baseline
	bun run spa/build.ts --indexeddb

serve-spa-indexeddb: spa-indexeddb ## serve IndexedDB baseline on 127.0.0.1:8082
	miniserve --interfaces 127.0.0.1 --port 8082 --index index.html spa/out-indexeddb

clean-spa: ## remove generated SPA output
	rm -rf spa/out spa/out-indexeddb

spa-zip: spa ## package the complete deployable encrypted SPA
	rm -f spa.zip
	cd spa/out && zip -r ../../spa.zip .

.PHONY: jspi-probe serve-jspi-probe
jspi-probe: ## build the standalone JSPI/OPFS probe
	wasm-pack build jspi-probe --target web --release --locked

serve-jspi-probe: jspi-probe ## serve the standalone probe on localhost:8081
	miniserve --interfaces 127.0.0.1 --port 8081 --index index.html jspi-probe

.PHONY: jspi-encryption
jspi-encryption: ## build the isolated Multiple Ciphers probe package
	wasm-pack build jspi-probe --target web --release --out-dir pkg-encryption --locked --features encryption
