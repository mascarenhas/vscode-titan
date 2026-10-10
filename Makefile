SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DELETE_ON_ERROR:

TITAN_REPO ?= ../titan
# Choose a whole-invocation profile before generating either native graph.
# Verification also exercises the ordinary server and disposable packaging.
VALIDATION_GOALS := verify test server-test server-test-build server-test-objects server-test-run server-test-sharded \
	server-coverage server-coverage-build server-coverage-run \
	server-protocol-test completion-protocol-test codex-native-test extension-host-test incremental-build-test install-server-test
BUILD_PROFILE ?= $(if $(TITAN_BUILD_PROFILE),$(TITAN_BUILD_PROFILE),$(if $(filter $(VALIDATION_GOALS),$(MAKECMDGOALS)),validation,production))
ifneq ($(BUILD_PROFILE),validation)
ifneq ($(BUILD_PROFILE),production)
$(error BUILD_PROFILE must be validation or production)
endif
endif
export BUILD_PROFILE
# BUILD_PROFILE owns this invocation even if the compiler knob was supplied
# on Make's command line; children must receive the same profile as the SDK.
override export TITAN_BUILD_PROFILE := $(BUILD_PROFILE)
TITAN_PREFIX ?= $(abspath $(if $(filter validation,$(BUILD_PROFILE)),.titan-validation,.titan))
override TITAN_PREFIX := $(abspath $(TITAN_PREFIX))
TITANC := $(TITAN_PREFIX)/bin/titanc
TITAN_LUA := $(TITAN_PREFIX)/bin/lua
LUAROCKS := $(TITAN_PREFIX)/bin/luarocks
TITAN_ROCKSPEC := titan-0.6.0-1.rockspec
TITAN_STANDARD_PROVIDER := $(TITAN_PREFIX)/lib/titan/0.6/titan.a
DEVELOPMENT_LUA_PATH := $(TITAN_PREFIX)/share/lua/5.5/?.lua;$(TITAN_PREFIX)/share/lua/5.5/?/init.lua
DEVELOPMENT_LUA_CPATH := $(TITAN_PREFIX)/lib/lua/5.5/?.so

SOURCE_ROOT ?= $(abspath src)
BUILD_ROOT ?= $(abspath .build)
override SOURCE_ROOT := $(abspath $(SOURCE_ROOT))
override BUILD_ROOT := $(abspath $(BUILD_ROOT))
SERVER_BUILD_DIR := $(BUILD_ROOT)/server
TEST_BUILD_DIR := $(BUILD_ROOT)/tests
SERVER_SOURCE_STAGE := $(BUILD_ROOT)/server-src
TEST_SOURCE_STAGE := $(BUILD_ROOT)/test-src
SERVER_INSTALL_STAGE := $(BUILD_ROOT)/install-root
VSIX_DIR := $(BUILD_ROOT)/vsix
NATIVE_BUILD_DIR := $(BUILD_ROOT)/native
SERVER_BUILD_OUTPUT := $(SERVER_BUILD_DIR)/titan_language_server
SERVER := $(abspath bin/titan-language-server)
override SERVER := $(abspath $(SERVER))
SERVER_TEST := $(TEST_BUILD_DIR)/server/tests
SERVER_COVERAGE_BUILD_DIR ?= $(abspath .build/coverage/direct)
SERVER_COVERAGE_REPORT_DIR ?= $(SERVER_COVERAGE_BUILD_DIR)/report
SERVER_COVERAGE_GCOV ?= gcov
SERVER_COVERAGE_GCOVR ?= gcovr
SERVER_COVERAGE_FORMATS ?=
SERVER_COVERAGE_TIMEOUT ?= 1200
COMPILER_IO_CLOCK_SOURCE := src/server/compiler_io_clock.c
COMPILER_IO_CLOCK_HEADER := src/server/compiler_io_clock.h
COMPILER_IO_CLOCK_OBJECT := $(NATIVE_BUILD_DIR)/compiler_io_clock.o
COMPILER_IO_PROCESS_FIXTURE := $(NATIVE_BUILD_DIR)/compiler_io_process_fixture
EMBEDDED_INTERFACES_GENERATOR := scripts/generate-embedded-interfaces.lua
EMBEDDED_INTERFACES_HEADER := src/server/embedded_interfaces_native.h
EMBEDDED_INTERFACES_SOURCE := $(NATIVE_BUILD_DIR)/embedded_interfaces_native.c
EMBEDDED_INTERFACES_OBJECT := $(NATIVE_BUILD_DIR)/embedded_interfaces_native.o
HOST_OS := $(shell uname -s)
HOST_ARCH := $(shell uname -m)
CC ?= cc
AR ?= ar
RANLIB ?= ranlib
OPENSSL_PKG_CONFIG ?= pkg-config
CCACHE_DISABLE ?= 1
NATIVE_OPTFLAGS := $(if $(filter validation,$(BUILD_PROFILE)),-O0 -fno-lto,-O3)
ifeq ($(BUILD_PROFILE),production)
ifeq ($(HOST_OS),Linux)
NATIVE_OPTFLAGS += -flto=auto -ffat-lto-objects
endif
endif
INSTALL_PREFIX ?= /usr/local

ifeq ($(HOST_OS),Linux)
EXPORT_LUA_LDFLAGS := -Wl,-E
ifeq ($(HOST_ARCH),x86_64)
DEFAULT_VSIX_TARGET := linux-x64
else ifeq ($(HOST_ARCH),aarch64)
DEFAULT_VSIX_TARGET := linux-arm64
else ifeq ($(HOST_ARCH),arm64)
DEFAULT_VSIX_TARGET := linux-arm64
else ifeq ($(HOST_ARCH),armv7l)
DEFAULT_VSIX_TARGET := linux-armhf
endif
else ifeq ($(HOST_OS),Darwin)
EXPORT_LUA_LDFLAGS := -Wl,-export_dynamic
ifeq ($(HOST_ARCH),x86_64)
DEFAULT_VSIX_TARGET := darwin-x64
else ifeq ($(HOST_ARCH),arm64)
DEFAULT_VSIX_TARGET := darwin-arm64
endif
else
$(error unsupported host OS $(HOST_OS); version 1 builds native packages on Linux and macOS)
endif

ifeq ($(strip $(DEFAULT_VSIX_TARGET)),)
$(error unsupported host architecture $(HOST_ARCH))
endif
ifneq ($(origin VSIX_TARGET),undefined)
ifneq ($(VSIX_TARGET),$(DEFAULT_VSIX_TARGET))
$(error VSIX_TARGET $(VSIX_TARGET) does not match this host-built binary ($(DEFAULT_VSIX_TARGET)))
endif
endif
VSIX_TARGET := $(DEFAULT_VSIX_TARGET)
VSIX := $(VSIX_DIR)/titan-$(VSIX_TARGET).vsix

.DEFAULT_GOAL := all

.PHONY: all help toolchain toolchain-refresh npm-ci server server-test \
	server-coverage server-coverage-build server-coverage-run \
	server-objects server-test-objects server-test-build server-test-run server-test-sharded shard-runner-test incremental-build-test \
	server-protocol-test completion-protocol-test codex-native-test extension extension-test extension-host-test test package inspect-server \
	plugin-validate verify inspect-vsix FORCE install-server install-server-test install-vsix clean clean-node

# The compiler intentionally checks only source/object timestamps. Make owns
# imported objects, native headers, SDK/compiler inputs and effective settings.
# The graph generator finishes both source stages before parallel recipes start.
shell_quote = '$(subst ','"'"',$(1))'
# LuaRocks launches nested Make processes and needs the recursive jobserver.
# Recursive recipes still run under -n/-t/-q; inspect only Make's short flags.
RECURSIVE_WRAPPER_GUARD = flags=$${MAKEFLAGS%% *}; case "$$flags" in -*) ;; *q*) exit 1 ;; *n*|*t*) exit 0 ;; esac;
NATIVE_BUILD_GENERATOR := scripts/generate-native-build.lua
NATIVE_BUILD_GRAPH := $(BUILD_ROOT)/native-modules.mk
NATIVE_CONFIG_STAMP := $(BUILD_ROOT)/native.config
NATIVE_BUILD_INPUTS = Makefile $(NATIVE_BUILD_GENERATOR) $(TITANC) $(TITAN_LUA) \
	$(NATIVE_SDK_INPUTS) $(BUILD_ROOT)/native-inputs/sdk
TEST_SUPPORT_STEM := $(TEST_BUILD_DIR)/titan/test__test_support
TEST_SUPPORT_OUTPUTS := $(addprefix $(TEST_SUPPORT_STEM),.o .c .ffi.h)
TEST_SUPPORT_SOURCE := $(TITAN_PREFIX)/share/titan/0.6/src/titan/test.titan
SERVER_LINK_OUTPUTS := $(SERVER_BUILD_OUTPUT) \
	$(SERVER_BUILD_DIR)/titan_language_server__entrypoint.c \
	$(SERVER_BUILD_DIR)/titan_language_server__entrypoint.o
TEST_LINK_OUTPUTS := $(SERVER_TEST) $(addprefix $(SERVER_TEST)__test_runner,.c .o .ffi.h) \
	$(addprefix $(SERVER_TEST)__test_entrypoint,.c .o)

# --tree selects each staged source root; compiled fallback is the explicit SDK.
# The test DAG uses the stdlib's dynamic-provider preference. Source-backed
# titan.test otherwise changes a static dependency's binding at the final link.
NATIVE_COMPILER_ENV = env -u LUA_PATH -u LUA_CPATH -u LUA_PATH_5_5 -u LUA_CPATH_5_5 -u TITAN_SOURCE_PATH \
	TITAN_BUILD_PROFILE=$(call shell_quote,$(BUILD_PROFILE)) \
	CC=$(call shell_quote,$(CC)) AR=$(call shell_quote,$(AR)) RANLIB=$(call shell_quote,$(RANLIB)) \
	CCACHE_DISABLE=$(call shell_quote,$(CCACHE_DISABLE)) \
	TITAN_ROCKS_ROOT=$(call shell_quote,$(TITAN_PREFIX)) \
	TITAN_PATH_0_6=$(call shell_quote,$(TITAN_PREFIX)/lib/titan/0.6) \
	TITAN_PATH=$(call shell_quote,$(TITAN_PREFIX)/lib/titan/0.6) \
	TITAN_EXTRA_CPPFLAGS=$(call shell_quote,$(strip $(TITAN_EXTRA_CPPFLAGS) $(NATIVE_OPENSSL_CPPFLAGS))) \
	TITAN_EXTRA_CFLAGS=$(call shell_quote,$(TITAN_EXTRA_CFLAGS)) \
	TITAN_EXTRA_LDFLAGS=$(call shell_quote,$(TITAN_EXTRA_LDFLAGS)) \
	TITAN_NO_LINE_DIRECTIVES=$(call shell_quote,$(TITAN_NO_LINE_DIRECTIVES)) \
	VSCODE_TITAN_OPENSSL_MODE=$(call shell_quote,$(NATIVE_OPENSSL_MODE)) \
	VSCODE_TITAN_OPENSSL_CPPFLAGS=$(call shell_quote,$(NATIVE_OPENSSL_CPPFLAGS)) \
	VSCODE_TITAN_OPENSSL_LDFLAGS=$(call shell_quote,$(NATIVE_OPENSSL_LDFLAGS)) \
	VSCODE_TITAN_OPENSSL_INCLUDEDIR=$(call shell_quote,$(NATIVE_OPENSSL_INCLUDEDIR))
NATIVE_LINK_ENV = $(NATIVE_COMPILER_ENV) \
	TITAN_EXTRA_LDFLAGS=$(call shell_quote,$(strip $(TITAN_EXTRA_LDFLAGS) $(EXPORT_LUA_LDFLAGS) $(COMPILER_IO_CLOCK_OBJECT) $(EMBEDDED_INTERFACES_OBJECT) $(TITAN_STANDARD_PROVIDER) $(NATIVE_OPENSSL_LDFLAGS)))
# Tests retain dynamic stdlib bindings but live outside the SDK's bin directory.
# Ask its Lua executable for its own relocatable paths, as Titan's test harness
# does. Ambient Titan paths must not replace that selected SDK at execution.
NATIVE_TEST_ENV = env -u TITAN_PATH_0_6 -u TITAN_PATH \
	TITAN_COMPILER_IO_PROCESS_FIXTURE=$(call shell_quote,$(COMPILER_IO_PROCESS_FIXTURE)) \
	CCACHE_DISABLE=$(call shell_quote,$(CCACHE_DISABLE)) \
	LUA_PATH_5_5="$$( $(call shell_quote,$(TITAN_LUA)) -E -e 'io.write(package.path)' )" \
	LUA_CPATH_5_5="$$( $(call shell_quote,$(TITAN_LUA)) -E -e 'io.write(package.cpath)' )"

FORCE:

# Keep housekeeping and JavaScript-only goals usable without a native SDK.
NON_NATIVE_GOALS := help clean clean-node toolchain toolchain-refresh npm-ci extension extension-test shard-runner-test incremental-build-test plugin-validate inspect-vsix server-test-run server-coverage-run
ifneq ($(filter-out $(NON_NATIVE_GOALS),$(if $(MAKECMDGOALS),$(MAKECMDGOALS),all)),)
# Titan installs OpenSSL headers only for its bundled provider. System-provider
# static consumers repeat the ordered pkg-config inputs after the archive.
NATIVE_OPENSSL_MODE := $(if $(wildcard $(TITAN_PREFIX)/include/openssl),bundled,system)
ifneq ($(wildcard $(TITANC)),)
ifeq ($(NATIVE_OPENSSL_MODE),system)
NATIVE_OPENSSL_READY := $(shell $(OPENSSL_PKG_CONFIG) --atleast-version=3.0.0 openssl && echo ready)
ifneq ($(NATIVE_OPENSSL_READY),ready)
$(error system OpenSSL >= 3.0 development files and pkg-config are required for this Titan SDK)
endif
NATIVE_OPENSSL_CPPFLAGS := $(shell $(OPENSSL_PKG_CONFIG) --cflags openssl || echo __titan_openssl_query_failed__)
NATIVE_OPENSSL_LDFLAGS := $(shell $(OPENSSL_PKG_CONFIG) --libs openssl || echo __titan_openssl_query_failed__)
NATIVE_OPENSSL_INCLUDEDIR := $(shell $(OPENSSL_PKG_CONFIG) --variable=includedir openssl || echo __titan_openssl_query_failed__)
ifneq ($(filter __titan_openssl_query_failed__,$(NATIVE_OPENSSL_CPPFLAGS) $(NATIVE_OPENSSL_LDFLAGS) $(NATIVE_OPENSSL_INCLUDEDIR)),)
$(error cannot query system OpenSSL compiler/linker inputs with $(OPENSSL_PKG_CONFIG))
endif
ifeq ($(strip $(NATIVE_OPENSSL_LDFLAGS)),)
$(error pkg-config returned no system OpenSSL libraries)
endif
ifeq ($(strip $(NATIVE_OPENSSL_INCLUDEDIR)),)
$(error pkg-config returned no system OpenSSL include directory)
endif
endif
endif
$(NATIVE_BUILD_GRAPH): FORCE $(NATIVE_BUILD_GENERATOR) | $(TITANC)
	@$(NATIVE_COMPILER_ENV) \
		LUA_PATH=$(call shell_quote,$(DEVELOPMENT_LUA_PATH)) \
		LUA_CPATH=$(call shell_quote,$(DEVELOPMENT_LUA_CPATH)) \
		TITANC=$(call shell_quote,$(TITANC)) TITAN_LUA=$(call shell_quote,$(TITAN_LUA)) \
		VSCODE_TITAN_EXPORT_FLAGS=$(call shell_quote,$(EXPORT_LUA_LDFLAGS)) \
		$(call shell_quote,$(TITAN_LUA)) $(call shell_quote,$(NATIVE_BUILD_GENERATOR)) \
		$(call shell_quote,$(abspath $(SOURCE_ROOT))) $(call shell_quote,$(abspath $(BUILD_ROOT))) \
		$(call shell_quote,$(TITAN_PREFIX))
include $(NATIVE_BUILD_GRAPH)
endif

all: server extension

help:
	@echo "vscode-titan targets:"
	@echo "  toolchain            build the selected project-local SDK ($(BUILD_PROFILE))"
	@echo "  toolchain-refresh    reinstall the sibling Titan checkout into the selected SDK"
	@echo "  server               build bin/titan-language-server as one native executable"
	@echo "  server-objects       compile production modules without linking"
	@echo "  server-test-objects  compile test/support modules without linking"
	@echo "  server-test          compile and run the native Titan protocol tests"
	@echo "  server-test-build    compile the native test aggregate once"
	@echo "  server-test-run      run the current native aggregate without rebuilding"
	@echo "  server-test-sharded  compile once and run two native execution shards"
	@echo "  server-coverage         build and run native tests with Titan line coverage"
	@echo "  server-coverage-build   build an isolated covered native aggregate (GCC 14+)"
	@echo "  server-coverage-run     run the covered aggregate and generate its reports"
	@echo "  completion-protocol-test  exercise unsaved completion through the native server"
	@echo "  incremental-build-test exercise native invalidation and no-op builds"
	@echo "  server-protocol-test exercise the native executable over framed stdio"
	@echo "  codex-native-test    query the native executable through the Codex adapter"
	@echo "  extension-test       compile and run the JavaScript unit tests"
	@echo "  extension-host-test  run the VS Code Extension Host smoke test"
	@echo "  test                 run the native Titan and JavaScript unit suites"
	@echo "  package              build $(VSIX) with the native server"
	@echo "  verify               run all tests, packaging, and artifact inspections"
	@echo "  install-server       install the server under INSTALL_PREFIX (default /usr/local)"
	@echo "  install-server-test  stage and inspect a server-only installation"
	@echo "  install-vsix         install the development VSIX with the VS Code CLI"

toolchain: $(TITANC)

$(TITANC):
	@test -f "$(abspath $(TITAN_REPO))/$(TITAN_ROCKSPEC)" || { \
		echo "Titan checkout not found at $(abspath $(TITAN_REPO))" >&2; \
		exit 1; \
	}
	$(MAKE) -C "$(abspath $(TITAN_REPO))" lua PREFIX="$(TITAN_PREFIX)"
	$(MAKE) -C "$(abspath $(TITAN_REPO))" luarocks PREFIX="$(TITAN_PREFIX)"
	+$(RECURSIVE_WRAPPER_GUARD) cd "$(abspath $(TITAN_REPO))" && \
		PATH="$(TITAN_PREFIX)/bin:$$PATH" \
		"$(LUAROCKS)" make --force "$(TITAN_ROCKSPEC)"
	@# Re-read SDK-dependent preflight even when a retained graph is unchanged.
	@if test -f $(call shell_quote,$(NATIVE_BUILD_GRAPH)); then \
		touch $(call shell_quote,$(NATIVE_BUILD_GRAPH)); \
	fi

toolchain-refresh: toolchain
	$(MAKE) -C "$(abspath $(TITAN_REPO))" lua PREFIX="$(TITAN_PREFIX)"
	$(MAKE) -C "$(abspath $(TITAN_REPO))" luarocks PREFIX="$(TITAN_PREFIX)"
	+$(RECURSIVE_WRAPPER_GUARD) cd "$(abspath $(TITAN_REPO))" && \
		PATH="$(TITAN_PREFIX)/bin:$$PATH" \
		"$(LUAROCKS)" make --force "$(TITAN_ROCKSPEC)"

npm-ci: node_modules/.package-lock.json

node_modules/.package-lock.json: package.json package-lock.json
	npm ci

server: $(SERVER)

$(COMPILER_IO_CLOCK_OBJECT): $(COMPILER_IO_CLOCK_SOURCE) $(COMPILER_IO_CLOCK_HEADER) \
	$(NATIVE_BUILD_INPUTS) $(NATIVE_CONFIG_STAMP)
	@mkdir -p "$(dir $(COMPILER_IO_CLOCK_OBJECT))"
	CCACHE_DISABLE="$(CCACHE_DISABLE)" $(CC) -std=c99 $(NATIVE_OPTFLAGS) $(TITAN_EXTRA_CFLAGS) \
		-Wall -Wextra -Werror \
		-c "$(COMPILER_IO_CLOCK_SOURCE)" \
		-o "$(COMPILER_IO_CLOCK_OBJECT)"

$(COMPILER_IO_PROCESS_FIXTURE): test/fixtures/compiler-io-process.c $(NATIVE_BUILD_INPUTS) $(NATIVE_CONFIG_STAMP)
	@mkdir -p "$(dir $(COMPILER_IO_PROCESS_FIXTURE))"
	CCACHE_DISABLE="$(CCACHE_DISABLE)" $(CC) -std=c99 $(NATIVE_OPTFLAGS) $(TITAN_EXTRA_CFLAGS) \
		-Wall -Wextra -Werror "$<" $(TITAN_EXTRA_LDFLAGS) -o "$@"

$(TITAN_STANDARD_PROVIDER): | $(TITANC)
	@test -f "$@" || { \
		echo "Titan standard provider not found at $@" >&2; \
		exit 1; \
	}

$(EMBEDDED_INTERFACES_SOURCE): $(EMBEDDED_INTERFACES_GENERATOR) \
	$(TITAN_STANDARD_PROVIDER) $(NATIVE_BUILD_INPUTS) $(NATIVE_CONFIG_STAMP)
	@mkdir -p "$(dir $(EMBEDDED_INTERFACES_SOURCE))"
	CCACHE_DISABLE="$(CCACHE_DISABLE)" CC="$(CC)" \
		TITAN_ROCKS_ROOT="$(TITAN_PREFIX)" \
		LUA_PATH="$(DEVELOPMENT_LUA_PATH)" \
		LUA_CPATH="$(DEVELOPMENT_LUA_CPATH)" \
		"$(TITAN_LUA)" "$(EMBEDDED_INTERFACES_GENERATOR)" \
		"$(TITAN_STANDARD_PROVIDER)" "$@"

$(EMBEDDED_INTERFACES_OBJECT): $(EMBEDDED_INTERFACES_SOURCE) \
	$(EMBEDDED_INTERFACES_HEADER) $(TITAN_STANDARD_PROVIDER) \
	$(NATIVE_BUILD_INPUTS) $(NATIVE_CONFIG_STAMP)
	@mkdir -p "$(dir $(EMBEDDED_INTERFACES_OBJECT))"
	CCACHE_DISABLE="$(CCACHE_DISABLE)" $(CC) -std=c99 $(NATIVE_OPTFLAGS) $(TITAN_EXTRA_CFLAGS) \
		-Wall -Wextra -Werror \
		-I "$(TITAN_PREFIX)/include" -I "$(abspath src/server)" \
		-c "$(EMBEDDED_INTERFACES_SOURCE)" \
		-o "$(EMBEDDED_INTERFACES_OBJECT)"

server-objects: $(SERVER_MODULE_OBJECTS)

$(SERVER_BUILD_OUTPUT): FORCE $(SERVER_MODULE_OBJECTS) $(COMPILER_IO_CLOCK_OBJECT) \
	$(EMBEDDED_INTERFACES_OBJECT) $(NATIVE_BUILD_INPUTS) $(NATIVE_CONFIG_STAMP)
	@set -e; stale=0; newer=$(call shell_quote,$(filter-out FORCE,$?)); \
	test -z "$$newer" || stale=1; \
	for output in $(foreach output,$(SERVER_LINK_OUTPUTS),$(call shell_quote,$(output))); do test -s "$$output" || stale=1; done; \
	test -x $(call shell_quote,$(SERVER_BUILD_OUTPUT)) || stale=1; \
	if test "$$stale" = 1; then \
	  cd $(call shell_quote,$(SERVER_BUILD_DIR)); \
	  $(NATIVE_LINK_ENV) $(call shell_quote,$(TITANC)) --static --source-first --incremental -j1 \
	    --tree $(call shell_quote,$(SERVER_SOURCE_STAGE)) titan_language_server; \
	fi

$(SERVER): $(SERVER_BUILD_OUTPUT)
	@mkdir -p $(call shell_quote,$(dir $(SERVER)))
	install -m 0755 $(call shell_quote,$(SERVER_BUILD_OUTPUT)) $(call shell_quote,$(SERVER))

server-test: server-test-build
	$(MAKE) server-test-run

$(TEST_SUPPORT_STEM).o: FORCE $(TEST_SUPPORT_SOURCE) $(NATIVE_BUILD_INPUTS) $(NATIVE_CONFIG_STAMP)
	@set -e; stale=0; newer=$(call shell_quote,$(filter-out FORCE,$?)); \
	test -z "$$newer" || stale=1; \
	for output in $(foreach output,$(TEST_SUPPORT_OUTPUTS),$(call shell_quote,$(output))); do test -f "$$output" || stale=1; done; \
	if test "$$stale" = 1; then \
	  rm -f $(call shell_quote,$@); \
	  cd $(call shell_quote,$(TEST_BUILD_DIR)); \
	  $(NATIVE_COMPILER_ENV) $(call shell_quote,$(TITANC)) --test --source-first --incremental -j1 -c \
	    --tree $(call shell_quote,$(TEST_SOURCE_STAGE)) titan.test; \
	fi

$(filter-out $(TEST_SUPPORT_STEM).o,$(TEST_SUPPORT_OUTPUTS)): $(TEST_SUPPORT_STEM).o
	@test -f $(call shell_quote,$@)

server-test-objects: $(TEST_MODULE_OBJECTS) $(TEST_SUPPORT_OUTPUTS)
server-test-build: $(SERVER_TEST) $(COMPILER_IO_PROCESS_FIXTURE)

$(SERVER_TEST): FORCE $(TEST_MODULE_OBJECTS) $(TEST_SUPPORT_OUTPUTS) $(COMPILER_IO_CLOCK_OBJECT) \
	$(EMBEDDED_INTERFACES_OBJECT) $(NATIVE_BUILD_INPUTS) $(NATIVE_CONFIG_STAMP)
	@set -e; stale=0; newer=$(call shell_quote,$(filter-out FORCE,$?)); \
	test -z "$$newer" || stale=1; \
	for output in $(foreach output,$(TEST_LINK_OUTPUTS),$(call shell_quote,$(output))); do test -s "$$output" || stale=1; done; \
	test -x $(call shell_quote,$(SERVER_TEST)) || stale=1; \
	if test "$$stale" = 1; then \
	  cd $(call shell_quote,$(TEST_BUILD_DIR)); \
	  $(NATIVE_LINK_ENV) $(call shell_quote,$(TITANC)) --test --source-first --incremental -j1 --no-uv-bootstrap \
	    --tree $(call shell_quote,$(TEST_SOURCE_STAGE)) server.tests; \
	fi

server-test-run:
	$(NATIVE_TEST_ENV) $(call shell_quote,$(SERVER_TEST))

server-test-sharded: server-test-build
	$(NATIVE_TEST_ENV) node scripts/run-server-tests.mjs $(call shell_quote,$(SERVER_TEST))

# Coverage uses a separate source tree; the test executable resets and reports
# its own counters through the compiler's embedded coverage inventory.
server-coverage-build: $(COMPILER_IO_CLOCK_OBJECT) $(EMBEDDED_INTERFACES_OBJECT) $(COMPILER_IO_PROCESS_FIXTURE)
	$(NATIVE_COMPILER_ENV) \
		VSCODE_TITAN_EXPORT_FLAGS=$(call shell_quote,$(EXPORT_LUA_LDFLAGS)) \
		node scripts/server-coverage.mjs build \
		--prefix $(call shell_quote,$(TITAN_PREFIX)) \
		--build-dir $(call shell_quote,$(abspath $(SERVER_COVERAGE_BUILD_DIR))) \
		--native-dir $(call shell_quote,$(NATIVE_BUILD_DIR)) \
		--cc $(call shell_quote,$(CC)) --gcov $(call shell_quote,$(SERVER_COVERAGE_GCOV)) \
		--report-dir $(call shell_quote,$(abspath $(SERVER_COVERAGE_REPORT_DIR))) \
		--gcovr $(call shell_quote,$(SERVER_COVERAGE_GCOVR)) \
		$(foreach format,$(SERVER_COVERAGE_FORMATS),--format $(call shell_quote,$(format)))

server-coverage-run:
	node scripts/server-coverage.mjs run \
		--build-dir $(call shell_quote,$(abspath $(SERVER_COVERAGE_BUILD_DIR))) \
		--timeout $(call shell_quote,$(SERVER_COVERAGE_TIMEOUT))

server-coverage: server-coverage-build
	+$(MAKE) server-coverage-run

shard-runner-test:
	node --test scripts/server-coverage.test.mjs scripts/run-extension-host-tests.test.mjs
	node --test scripts/run-server-tests.test.mjs
	node --test scripts/openssl-packaging.test.mjs
	node --test scripts/build-windows.test.mjs scripts/inspect-windows-package.test.mjs \
		scripts/compiler-rocks.test.mjs scripts/stage-lua-modules.test.mjs scripts/stage-notices.test.mjs

incremental-build-test:
	node scripts/test-incremental-build.mjs --prefix $(call shell_quote,$(TITAN_PREFIX))

server-protocol-test: $(SERVER) completion-protocol-test
	TITAN_LS_LUA_PATH='$(DEVELOPMENT_LUA_PATH)' \
	TITAN_LS_LUA_CPATH='$(DEVELOPMENT_LUA_CPATH)' \
		node scripts/test-server-protocol.mjs "$(SERVER)"
	TITAN_LS_LUA_PATH='$(DEVELOPMENT_LUA_PATH)' \
	TITAN_LS_LUA_CPATH='$(DEVELOPMENT_LUA_CPATH)' \
		node scripts/test-workspace-cache.mjs "$(SERVER)"

completion-protocol-test: $(SERVER)
	TITAN_LS_LUA_PATH='$(DEVELOPMENT_LUA_PATH)' \
	TITAN_LS_LUA_CPATH='$(DEVELOPMENT_LUA_CPATH)' \
		node scripts/test-completion-protocol.mjs "$(SERVER)"

codex-native-test: $(SERVER)
	TITAN_LS_LUA_PATH='$(DEVELOPMENT_LUA_PATH)' \
	TITAN_LS_LUA_CPATH='$(DEVELOPMENT_LUA_CPATH)' \
		node scripts/test-codex-native.mjs "$(SERVER)"

extension: npm-ci | $(TITANC)
	TITAN_PREFIX=$(call shell_quote,$(TITAN_PREFIX)) npm run compile

extension-test: npm-ci
	TITAN_PREFIX=$(call shell_quote,$(TITAN_PREFIX)) npm test

extension-host-test: $(SERVER) npm-ci
	TITAN_PREFIX=$(call shell_quote,$(TITAN_PREFIX)) \
	TITAN_LSP_TEST_SERVER=$(call shell_quote,$(SERVER)) npm run test:vscode

test: server-test-sharded server-protocol-test codex-native-test extension-test shard-runner-test incremental-build-test

package: $(SERVER) npm-ci
	@mkdir -p "$(VSIX_DIR)"
	TITAN_PREFIX=$(call shell_quote,$(TITAN_PREFIX)) npm run compile
	@selected_server=$(call shell_quote,$(SERVER)); \
	packaged_server=$(call shell_quote,$(abspath bin/titan-language-server)); \
	staged_server=; backup_dir=; restore_original=0; \
	cleanup_package_server() { \
	  status=$$?; trap - EXIT; \
	  [[ -z "$$staged_server" ]] || rm -f -- "$$staged_server" || status=1; \
	  staged_server=; \
	  if [[ "$$restore_original" = 1 ]]; then \
	    if [[ -e "$$backup_dir/server" || -L "$$backup_dir/server" ]]; then \
	      if staged_server=$$(mktemp "$$packaged_server.tmp.XXXXXX") && \
	        rm -f -- "$$staged_server" && \
	        cp -pP "$$backup_dir/server" "$$staged_server" && \
	        mv -f -- "$$staged_server" "$$packaged_server"; then :; \
	      else \
	        echo "Cannot restore package server; original retained at $$backup_dir/server" >&2; \
	        rm -f -- "$$staged_server"; exit 1; \
	      fi; \
	    else rm -f -- "$$packaged_server" || status=1; fi; \
	  fi; \
	  [[ -z "$$staged_server" ]] || rm -f -- "$$staged_server" || status=1; \
	  [[ -z "$$backup_dir" ]] || rm -rf -- "$$backup_dir" || status=1; \
	  exit "$$status"; \
	}; \
	trap cleanup_package_server EXIT; \
	if [[ "$$selected_server" != "$$packaged_server" ]]; then \
	  mkdir -p -- "$$(dirname -- "$$packaged_server")" $(call shell_quote,$(abspath .build)); \
	  backup_dir=$$(mktemp -d $(call shell_quote,$(abspath .build/package-server.XXXXXX))); \
	  if [[ -e "$$packaged_server" || -L "$$packaged_server" ]]; then \
	    cp -pP "$$packaged_server" "$$backup_dir/server"; \
	  fi; \
	  staged_server=$$(mktemp "$$packaged_server.tmp.XXXXXX"); \
	  install -m 0755 "$$selected_server" "$$staged_server"; \
	  restore_original=1; \
	  mv -f -- "$$staged_server" "$$packaged_server"; \
	fi; \
	TITAN_REPO=$(call shell_quote,$(TITAN_REPO)) \
	TITAN_PREFIX=$(call shell_quote,$(TITAN_PREFIX)) \
	./node_modules/.bin/vsce package --no-dependencies \
		--target $(call shell_quote,$(VSIX_TARGET)) --out $(call shell_quote,$(VSIX))

inspect-server: $(SERVER)
	TITAN_PREFIX=$(call shell_quote,$(TITAN_PREFIX)) ./scripts/inspect-server.sh "$(SERVER)"

plugin-validate:
	node scripts/validate-plugin.mjs

verify: test extension-host-test package inspect-server plugin-validate install-server-test
	$(MAKE) inspect-vsix

inspect-vsix:
	TITAN_PREFIX="$(TITAN_PREFIX)" \
		OPENSSL_PKG_CONFIG=$(call shell_quote,$(OPENSSL_PKG_CONFIG)) \
		./scripts/inspect-vsix.sh "$(VSIX)" "$(VSIX_TARGET)"

install-server: $(SERVER)
	install -d "$(DESTDIR)$(INSTALL_PREFIX)/bin"
	install -m 0755 "$(SERVER)" \
		"$(DESTDIR)$(INSTALL_PREFIX)/bin/titan-language-server"
	install -d "$(DESTDIR)$(INSTALL_PREFIX)/share/doc/titan-language-server/LICENSES"
	install -m 0644 LICENSE \
		"$(DESTDIR)$(INSTALL_PREFIX)/share/doc/titan-language-server/LICENSE"
	install -m 0644 "$(abspath $(TITAN_REPO))/LICENSE" \
		"$(DESTDIR)$(INSTALL_PREFIX)/share/doc/titan-language-server/Titan-LICENSE"
	install -m 0644 "$(TITAN_PREFIX)/share/titan/THIRD_PARTY_NOTICES.md" \
		"$(DESTDIR)$(INSTALL_PREFIX)/share/doc/titan-language-server/THIRD_PARTY_NOTICES.md"
	install -m 0644 "$(TITAN_PREFIX)"/share/titan/LICENSES/* \
		"$(DESTDIR)$(INSTALL_PREFIX)/share/doc/titan-language-server/LICENSES/"

install-server-test: $(SERVER)
	rm -rf -- "$(SERVER_INSTALL_STAGE)"
	$(MAKE) install-server \
		DESTDIR="$(SERVER_INSTALL_STAGE)" INSTALL_PREFIX=/usr/local
	test -x "$(SERVER_INSTALL_STAGE)/usr/local/bin/titan-language-server"
	test -f "$(SERVER_INSTALL_STAGE)/usr/local/share/doc/titan-language-server/LICENSE"
	cmp -s LICENSE \
		"$(SERVER_INSTALL_STAGE)/usr/local/share/doc/titan-language-server/LICENSE"
	test -f "$(SERVER_INSTALL_STAGE)/usr/local/share/doc/titan-language-server/Titan-LICENSE"
	test -f "$(SERVER_INSTALL_STAGE)/usr/local/share/doc/titan-language-server/THIRD_PARTY_NOTICES.md"
	test -f "$(SERVER_INSTALL_STAGE)/usr/local/share/doc/titan-language-server/LICENSES/libuv-LICENSE"
	test -f "$(SERVER_INSTALL_STAGE)/usr/local/share/doc/titan-language-server/LICENSES/libuv-LICENSE-extra"
	test -f "$(SERVER_INSTALL_STAGE)/usr/local/share/doc/titan-language-server/LICENSES/libuv-tree-LICENSE"
	test -f "$(SERVER_INSTALL_STAGE)/usr/local/share/doc/titan-language-server/LICENSES/libuv-inet-LICENSE"
	test -f "$(SERVER_INSTALL_STAGE)/usr/local/share/doc/titan-language-server/LICENSES/openssl-LICENSE"

install-vsix: package
	code --install-extension "$(VSIX)" --force

clean:
	rm -rf -- "$(BUILD_ROOT)" "$(SERVER)" dist dist-test
	rm -f -- \
		"$(abspath bridge_source_definition_consumer.a)" \
		"$(abspath bridge_source_definition_consumer.so)"

clean-node:
	rm -rf -- node_modules .vscode-test
