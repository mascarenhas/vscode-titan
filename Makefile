SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DELETE_ON_ERROR:

# This file needs GNU Make 4.2: $(.SHELLSTATUS), which SDK discovery below reads
# to detect a failed titanc lookup, is the newest feature used anywhere here
# (.SHELLFLAGS needs 3.82). Guard before discovery so macOS's stock
# /usr/bin/make 3.81 reports this instead of a missing-SDK error.
MINIMUM_MAKE_VERSION := 4.2
MAKE_VERSION_MAJOR := $(firstword $(subst ., ,$(MAKE_VERSION)))
MAKE_VERSION_MINOR := $(word 2,$(subst ., ,$(MAKE_VERSION)))
# Accept any major above 4 and 4.2 or newer; everything else, including a make
# that does not identify its version, fails the guard.
MAKE_VERSION_SUPPORTED := $(if $(filter 4,$(MAKE_VERSION_MAJOR)),$(filter-out 0 1,$(MAKE_VERSION_MINOR)),$(filter-out 0 1 2 3,$(MAKE_VERSION_MAJOR)))
ifeq ($(strip $(MAKE_VERSION_SUPPORTED)),)
$(error this Makefile needs GNU Make $(MINIMUM_MAKE_VERSION) or newer, but found $(if $(MAKE_VERSION),GNU Make $(MAKE_VERSION),an unidentified make); on macOS, install GNU Make with "brew install make" and put "$$(brew --prefix make)/libexec/gnubin" first on PATH, as docs/native-build.md describes)
endif

# Choose a whole-invocation profile for compiler-owned builds.
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
# on Make's command line; children must receive the same project profile.
override export TITAN_BUILD_PROFILE := $(BUILD_PROFILE)
SDK_FREE_GOALS := help clean clean-node npm-ci extension-test shard-runner-test plugin-validate
ifneq ($(strip $(TITAN_PREFIX)),)
override TITAN_PREFIX := $(abspath $(TITAN_PREFIX))
else ifneq ($(filter-out $(SDK_FREE_GOALS),$(if $(MAKECMDGOALS),$(MAKECMDGOALS),all)),)
override TITAN_PREFIX := $(shell node scripts/titan-sdk.mjs --print-prefix)
ifneq ($(.SHELLSTATUS),0)
$(error cannot select an installed Titan SDK; set TITAN_PREFIX or put titanc on PATH)
endif
endif
TITANC := $(TITAN_PREFIX)/bin/titanc
TITAN_LUA := $(TITAN_PREFIX)/bin/lua
TITAN_STANDARD_PROVIDER := $(TITAN_PREFIX)/lib/titan/0.6/titan.a
DEVELOPMENT_LUA_PATH := $(TITAN_PREFIX)/share/lua/5.5/?.lua;$(TITAN_PREFIX)/share/lua/5.5/?/init.lua
DEVELOPMENT_LUA_CPATH := $(TITAN_PREFIX)/lib/lua/5.5/?.so

SOURCE_ROOT ?= $(abspath src)
BUILD_ROOT ?= $(abspath .build)
override SOURCE_ROOT := $(abspath $(SOURCE_ROOT))
override BUILD_ROOT := $(abspath $(BUILD_ROOT))
SERVER_BUILD_DIR := $(BUILD_ROOT)/server
TEST_BUILD_DIR := $(BUILD_ROOT)/tests
SERVER_INSTALL_STAGE := $(BUILD_ROOT)/install-root
VSIX_DIR := $(BUILD_ROOT)/vsix
NATIVE_BUILD_DIR := $(BUILD_ROOT)/native
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
COMPILER_IO_PROCESS_FIXTURE := $(NATIVE_BUILD_DIR)/compiler_io_process_fixture
EMBEDDED_INTERFACES_GENERATOR := scripts/generate-embedded-interfaces.lua
EMBEDDED_INTERFACES_SOURCE := $(NATIVE_BUILD_DIR)/embedded_interfaces_native.c
HOST_OS := $(shell uname -s)
HOST_ARCH := $(shell uname -m)
CC ?= cc
AR ?= ar
RANLIB ?= ranlib
export CC AR RANLIB CCACHE_DISABLE
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

.PHONY: all help npm-ci server server-test \
	server-coverage server-coverage-build server-coverage-run \
	server-objects server-test-objects server-test-build server-test-run server-test-sharded shard-runner-test incremental-build-test \
	server-protocol-test completion-protocol-test codex-native-test extension extension-test extension-host-test test package inspect-server \
	plugin-validate verify inspect-vsix install-server install-server-test install-vsix clean clean-node

# titanc owns module discovery, certification, scheduling and final outputs.
shell_quote = '$(subst ','"'"',$(1))'
COMPILER_ENV = env -u LUA_PATH -u LUA_CPATH -u LUA_PATH_5_5 -u LUA_CPATH_5_5 -u TITAN_SOURCE_PATH \
	TITAN_ROOT=$(call shell_quote,$(TITAN_PREFIX)) \
	TITAN_PREFIX=$(call shell_quote,$(BUILD_ROOT)/compiler-cache) \
	TITAN_PATH_0_6=$(call shell_quote,$(TITAN_PREFIX)/lib/titan/0.6) \
	TITAN_PATH=$(call shell_quote,$(TITAN_PREFIX)/lib/titan/0.6)
TITAN_FLAGS ?=
TITAN_COMPILE_FLAGS = $(TITAN_FLAGS) --tree $(call shell_quote,$(SOURCE_ROOT)) --source-first --incremental --static \
	-I $(call shell_quote,$(abspath src/server)) \
	$(foreach flag,$(OPENSSL_CPPFLAGS),--cflag=$(call shell_quote,$(flag)))
TITAN_LINK_FLAGS = --ldflag=$(call shell_quote,$(EXPORT_LUA_LDFLAGS)) \
	--ldflag=$(call shell_quote,$(TITAN_STANDARD_PROVIDER)) \
	$(foreach flag,$(OPENSSL_LDFLAGS),--ldflag=$(call shell_quote,$(flag))) \
	--c-source $(call shell_quote,$(COMPILER_IO_CLOCK_SOURCE)) \
	--c-source $(call shell_quote,$(EMBEDDED_INTERFACES_SOURCE))
# Tests load compiler Lua dependencies outside the SDK's bin directory.
# Ask its Lua executable for its own relocatable paths, as Titan's test harness
# does. Ambient Titan paths must not replace that selected SDK at execution.
TEST_ENV = env -u TITAN_PATH_0_6 -u TITAN_PATH \
	TITAN_ROOT=$(call shell_quote,$(TITAN_PREFIX)) \
	TITAN_PREFIX=$(call shell_quote,$(BUILD_ROOT)/compiler-cache) \
	TITAN_COMPILER_IO_PROCESS_FIXTURE=$(call shell_quote,$(COMPILER_IO_PROCESS_FIXTURE)) \
	CCACHE_DISABLE=$(call shell_quote,$(CCACHE_DISABLE)) \
	LUA_PATH_5_5="$$( $(call shell_quote,$(TITAN_LUA)) -E -e 'io.write(package.path)' )" \
	LUA_CPATH_5_5="$$( $(call shell_quote,$(TITAN_LUA)) -E -e 'io.write(package.cpath)' )"

# The server selects its workspace probe cache; TITAN_PREFIX here selects the SDK.
SERVER_TEST_ENV = env -u TITAN_PREFIX -u TITAN_PATH_0_6 -u TITAN_PATH -u TITAN_SOURCE_PATH \
	CC=$(call shell_quote,$(CC)) CCACHE_DISABLE=$(call shell_quote,$(CCACHE_DISABLE)) \
	TITAN_EXTRA_CPPFLAGS=$(call shell_quote,$(strip $(TITAN_EXTRA_CPPFLAGS) $(OPENSSL_CPPFLAGS))) \
	TITAN_ROOT=$(call shell_quote,$(TITAN_PREFIX)) \
	TITAN_LS_LUA_PATH=$(call shell_quote,$(DEVELOPMENT_LUA_PATH)) \
	TITAN_LS_LUA_CPATH=$(call shell_quote,$(DEVELOPMENT_LUA_CPATH))

# Keep housekeeping and JavaScript-only goals usable without a native SDK.
NON_NATIVE_GOALS := help clean clean-node npm-ci extension extension-test shard-runner-test incremental-build-test plugin-validate inspect-vsix server-test-run server-coverage-run
ifneq ($(filter-out $(NON_NATIVE_GOALS),$(if $(MAKECMDGOALS),$(MAKECMDGOALS),all)),)
# Titan installs OpenSSL headers only for its bundled provider. System-provider
# static consumers repeat the ordered pkg-config inputs after the archive.
OPENSSL_MODE := $(if $(wildcard $(TITAN_PREFIX)/include/openssl),bundled,system)
ifneq ($(wildcard $(TITANC)),)
ifeq ($(OPENSSL_MODE),system)
OPENSSL_READY := $(shell $(OPENSSL_PKG_CONFIG) --atleast-version=3.0.0 openssl && echo ready)
ifneq ($(OPENSSL_READY),ready)
$(error system OpenSSL >= 3.0 development files and pkg-config are required for this Titan SDK)
endif
OPENSSL_CPPFLAGS := $(shell $(OPENSSL_PKG_CONFIG) --cflags openssl || echo __titan_openssl_query_failed__)
OPENSSL_LDFLAGS := $(shell $(OPENSSL_PKG_CONFIG) --libs openssl || echo __titan_openssl_query_failed__)
ifneq ($(filter __titan_openssl_query_failed__,$(OPENSSL_CPPFLAGS) $(OPENSSL_LDFLAGS)),)
$(error cannot query system OpenSSL compiler/linker inputs with $(OPENSSL_PKG_CONFIG))
endif
ifeq ($(strip $(OPENSSL_LDFLAGS)),)
$(error pkg-config returned no system OpenSSL libraries)
endif
endif
endif
endif

all: server extension

help:
	@echo "vscode-titan targets:"
	@echo "  SDK selection            TITAN_PREFIX override, otherwise titanc --print-root from PATH"
	@echo ""
	@echo "  Build:"
	@echo "    all                      build the server and the extension (default)"
	@echo "    server                   build bin/titan-language-server as one native executable"
	@echo "    extension                compile dist/extension.js and stage its SDK payload"
	@echo "    npm-ci                   install the dependencies pinned in package-lock.json"
	@echo "    package                  build $(VSIX) with the native server"
	@echo ""
	@echo "  Test:"
	@echo "    test                     run the native, protocol, Codex, extension, script and incremental-build suites"
	@echo "    server-test              compile and run the native Titan protocol tests"
	@echo "    server-test-build        compile the native test aggregate once"
	@echo "    server-test-run          run the current native aggregate without rebuilding"
	@echo "    server-test-sharded      compile once and run two native execution shards"
	@echo "    server-protocol-test     exercise the native executable over framed stdio"
	@echo "    completion-protocol-test exercise unsaved completion through the native server"
	@echo "    codex-native-test        query the native executable through the Codex adapter"
	@echo "    extension-test           compile and run the JavaScript unit tests"
	@echo "    extension-host-test      run the VS Code Extension Host smoke test"
	@echo "    shard-runner-test        run the unit tests for the build and test-runner scripts"
	@echo "    incremental-build-test   smoke-test compiler-owned incremental builds"
	@echo ""
	@echo "  Coverage:"
	@echo "    server-coverage          build and run native tests with Titan line coverage"
	@echo "    server-coverage-build    build an isolated covered native aggregate (GCC 14+)"
	@echo "    server-coverage-run      run the covered aggregate and generate its reports"
	@echo ""
	@echo "  Inspect and install:"
	@echo "    verify                   run all tests, packaging and artifact inspections"
	@echo "    inspect-server           inspect the server executable and its native dependencies"
	@echo "    inspect-vsix             inspect the packaged VSIX contents"
	@echo "    plugin-validate          validate the Codex plugin marketplace and bundle"
	@echo "    install-server           install the server under INSTALL_PREFIX (default /usr/local)"
	@echo "    install-server-test      stage and inspect a server-only installation"
	@echo "    install-vsix             install the development VSIX with the VS Code CLI"
	@echo ""
	@echo "  Build steps:"
	@echo "    server-build             compile and link the server executable"
	@echo "    server-objects           compile production modules without linking"
	@echo "    server-test-objects      compile test modules without linking"
	@echo ""
	@echo "  Housekeeping:"
	@echo "    clean                    remove build outputs and the built server"
	@echo "    clean-node               remove node_modules and .vscode-test"
	@echo "    help                     list these targets"

$(TITANC):
	@echo "Titan compiler is missing at $@; install Titan or select another TITAN_PREFIX" >&2
	@exit 1

npm-ci: node_modules/.package-lock.json

node_modules/.package-lock.json: package.json package-lock.json
	npm ci

server: $(SERVER)

$(COMPILER_IO_PROCESS_FIXTURE): test/fixtures/compiler-io-process.c
	@mkdir -p "$(dir $(COMPILER_IO_PROCESS_FIXTURE))"
	CCACHE_DISABLE="$(CCACHE_DISABLE)" $(CC) -std=c99 $(NATIVE_OPTFLAGS) $(TITAN_EXTRA_CFLAGS) \
		-Wall -Wextra -Werror "$<" $(TITAN_EXTRA_LDFLAGS) -o "$@"

$(TITAN_STANDARD_PROVIDER): | $(TITANC)
	@test -f "$@" || { \
		echo "Titan standard provider not found at $@" >&2; \
		exit 1; \
	}

# Equal generated bytes still need to acknowledge successfully checked inputs.
$(EMBEDDED_INTERFACES_SOURCE): $(EMBEDDED_INTERFACES_GENERATOR) $(TITAN_STANDARD_PROVIDER)
	@mkdir -p "$(dir $(EMBEDDED_INTERFACES_SOURCE))"
	CCACHE_DISABLE="$(CCACHE_DISABLE)" CC="$(CC)" \
		TITAN_ROOT="$(TITAN_PREFIX)" \
		LUA_PATH="$(DEVELOPMENT_LUA_PATH)" \
		LUA_CPATH="$(DEVELOPMENT_LUA_CPATH)" \
		"$(TITAN_LUA)" "$(EMBEDDED_INTERFACES_GENERATOR)" \
		"$(TITAN_STANDARD_PROVIDER)" "$@"
	@touch "$@"

server-objects: | $(TITANC)
	+$(COMPILER_ENV) $(call shell_quote,$(TITANC)) $(TITAN_COMPILE_FLAGS) \
		--output $(call shell_quote,$(SERVER_BUILD_DIR)) -c titan_language_server

$(SERVER): server-build

.PHONY: server-build
server-build: $(EMBEDDED_INTERFACES_SOURCE) | $(TITANC)
	+$(COMPILER_ENV) $(call shell_quote,$(TITANC)) $(TITAN_COMPILE_FLAGS) \
		--output $(call shell_quote,$(SERVER_BUILD_DIR)) --exe $(call shell_quote,$(SERVER)) \
		$(TITAN_LINK_FLAGS) titan_language_server

server-test: server-test-build
	+$(MAKE) server-test-run

server-test-objects: | $(TITANC)
	+$(COMPILER_ENV) $(call shell_quote,$(TITANC)) $(TITAN_COMPILE_FLAGS) \
		--output $(call shell_quote,$(TEST_BUILD_DIR)) --test -c server.tests

server-test-build: $(EMBEDDED_INTERFACES_SOURCE) $(COMPILER_IO_PROCESS_FIXTURE) | $(TITANC)
	+$(COMPILER_ENV) $(call shell_quote,$(TITANC)) $(TITAN_COMPILE_FLAGS) \
		--output $(call shell_quote,$(TEST_BUILD_DIR)) --exe $(call shell_quote,$(SERVER_TEST)) \
		--test --no-uv-bootstrap $(TITAN_LINK_FLAGS) server.tests

server-test-run:
	$(TEST_ENV) $(call shell_quote,$(SERVER_TEST))

server-test-sharded: server-test-build
	$(TEST_ENV) node scripts/run-server-tests.mjs $(call shell_quote,$(SERVER_TEST))

# Coverage uses a separate source tree; the test executable resets and reports
# its own counters through the compiler's embedded coverage inventory.
server-coverage-build: $(EMBEDDED_INTERFACES_SOURCE) $(COMPILER_IO_PROCESS_FIXTURE)
	+$(COMPILER_ENV) node scripts/server-coverage.mjs build \
		--prefix $(call shell_quote,$(TITAN_PREFIX)) \
		--build-dir $(call shell_quote,$(abspath $(SERVER_COVERAGE_BUILD_DIR))) \
		--native-dir $(call shell_quote,$(NATIVE_BUILD_DIR)) \
		--cc $(call shell_quote,$(CC)) --gcov $(call shell_quote,$(SERVER_COVERAGE_GCOV)) \
		--report-dir $(call shell_quote,$(abspath $(SERVER_COVERAGE_REPORT_DIR))) \
		--gcovr $(call shell_quote,$(SERVER_COVERAGE_GCOVR)) \
		$(foreach flag,$(OPENSSL_CPPFLAGS),--cflag $(call shell_quote,$(flag))) \
		$(foreach flag,$(OPENSSL_LDFLAGS),--ldflag $(call shell_quote,$(flag))) \
		$(foreach format,$(SERVER_COVERAGE_FORMATS),--format $(call shell_quote,$(format)))

server-coverage-run:
	node scripts/server-coverage.mjs run \
		--build-dir $(call shell_quote,$(abspath $(SERVER_COVERAGE_BUILD_DIR))) \
		--timeout $(call shell_quote,$(SERVER_COVERAGE_TIMEOUT))

server-coverage: server-coverage-build
	+$(MAKE) server-coverage-run

shard-runner-test:
	node --test scripts/titan-sdk.test.mjs
	node --test scripts/server-coverage.test.mjs scripts/run-extension-host-tests.test.mjs
	node --test scripts/run-server-tests.test.mjs
	node --test scripts/openssl-packaging.test.mjs
	node --test scripts/makefile-contract.test.mjs
	node --test scripts/build-windows.test.mjs scripts/inspect-windows-package.test.mjs \
		scripts/compiler-rocks.test.mjs scripts/stage-lua-modules.test.mjs scripts/stage-notices.test.mjs

incremental-build-test:
	node scripts/test-incremental-build.mjs --prefix $(call shell_quote,$(TITAN_PREFIX))

server-protocol-test: $(SERVER) completion-protocol-test
	$(SERVER_TEST_ENV) node scripts/test-server-protocol.mjs "$(SERVER)"
	$(SERVER_TEST_ENV) node scripts/test-workspace-cache.mjs "$(SERVER)"

completion-protocol-test: $(SERVER)
	$(SERVER_TEST_ENV) node scripts/test-completion-protocol.mjs "$(SERVER)"

codex-native-test: $(SERVER)
	$(SERVER_TEST_ENV) node scripts/test-codex-native.mjs "$(SERVER)"

extension: npm-ci | $(TITANC)
	TITAN_PREFIX=$(call shell_quote,$(TITAN_PREFIX)) npm run compile

extension-test: npm-ci
	npm test

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
	install -m 0644 "$(TITAN_PREFIX)/share/titan/LICENSE" \
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
