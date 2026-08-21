SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

TITAN_REPO ?= ../titan
TITAN_PREFIX := $(abspath .titan)
TITANC := $(TITAN_PREFIX)/bin/titanc
LUAROCKS := $(TITAN_PREFIX)/bin/luarocks

SOURCE_ROOT := $(abspath src)
BUILD_ROOT := $(abspath .build)
SERVER_BUILD_DIR := $(BUILD_ROOT)/server
TEST_BUILD_DIR := $(BUILD_ROOT)/tests
SERVER_SOURCE_STAGE := $(BUILD_ROOT)/server-src
TEST_SOURCE_STAGE := $(BUILD_ROOT)/test-src
SERVER_INSTALL_STAGE := $(BUILD_ROOT)/install-root
VSIX_DIR := $(BUILD_ROOT)/vsix
SERVER_BUILD_OUTPUT := $(SERVER_BUILD_DIR)/titan_language_server
SERVER := $(abspath bin/titan-language-server)
SERVER_TEST := $(TEST_BUILD_DIR)/server/tests
SERVER_SOURCES := $(shell find src -type f -name '*.titan' -print 2>/dev/null)
SERVER_SOURCE_DIRS := src $(shell find src/server -type d -print 2>/dev/null)
HOST_OS := $(shell uname -s)
HOST_ARCH := $(shell uname -m)
CCACHE_DISABLE ?= 1
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
	server-protocol-test extension extension-test extension-host-test test package inspect-server \
	plugin-validate verify install-server install-server-test install-vsix clean clean-node

all: server extension

help:
	@echo "vscode-titan targets:"
	@echo "  toolchain            build the ignored project-local .titan installation"
	@echo "  toolchain-refresh    reinstall the sibling Titan checkout into .titan"
	@echo "  server               build bin/titan-language-server as one native executable"
	@echo "  server-test          compile and run the native Titan protocol tests"
	@echo "  server-protocol-test exercise the native executable over framed stdio"
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
	@test -f "$(abspath $(TITAN_REPO))/titan-dev-1.rockspec" || { \
		echo "Titan checkout not found at $(abspath $(TITAN_REPO))" >&2; \
		exit 1; \
	}
	$(MAKE) -C "$(abspath $(TITAN_REPO))" lua PREFIX="$(TITAN_PREFIX)"
	$(MAKE) -C "$(abspath $(TITAN_REPO))" luarocks PREFIX="$(TITAN_PREFIX)"
	$(MAKE) -C "$(abspath $(TITAN_REPO))" libuv PREFIX="$(TITAN_PREFIX)"
	cd "$(abspath $(TITAN_REPO))" && \
		PATH="$(TITAN_PREFIX)/bin:$$PATH" \
		"$(LUAROCKS)" make --force titan-dev-1.rockspec

toolchain-refresh: toolchain
	cd "$(abspath $(TITAN_REPO))" && \
		PATH="$(TITAN_PREFIX)/bin:$$PATH" \
		"$(LUAROCKS)" make --force titan-dev-1.rockspec

npm-ci: node_modules/.package-lock.json

node_modules/.package-lock.json: package.json package-lock.json
	npm ci

server: $(SERVER)

$(SERVER): $(SERVER_SOURCES) $(SERVER_SOURCE_DIRS) Makefile | $(TITANC)
	rm -rf -- "$(SERVER_SOURCE_STAGE)"
	@mkdir -p "$(SERVER_BUILD_DIR)" "$(SERVER_SOURCE_STAGE)" "$(dir $(SERVER))"
	cp -a "$(SOURCE_ROOT)/." "$(SERVER_SOURCE_STAGE)/"
	cd "$(SERVER_BUILD_DIR)" && \
		CCACHE_DISABLE="$(CCACHE_DISABLE)" \
		TITAN_EXTRA_LDFLAGS="$(strip $(TITAN_EXTRA_LDFLAGS) $(EXPORT_LUA_LDFLAGS))" \
		"$(TITANC)" --static --tree "$(SERVER_SOURCE_STAGE)" titan_language_server
	install -m 0755 "$(SERVER_BUILD_OUTPUT)" "$(SERVER)"

server-test: $(SERVER_SOURCES) | $(TITANC)
	rm -rf -- "$(TEST_SOURCE_STAGE)"
	@mkdir -p "$(TEST_BUILD_DIR)" "$(TEST_SOURCE_STAGE)"
	cp -a "$(SOURCE_ROOT)/." "$(TEST_SOURCE_STAGE)/"
	cd "$(TEST_BUILD_DIR)" && \
		CCACHE_DISABLE="$(CCACHE_DISABLE)" \
		TITAN_EXTRA_LDFLAGS="$(strip $(TITAN_EXTRA_LDFLAGS) $(EXPORT_LUA_LDFLAGS))" \
		"$(TITANC)" --static --test --no-uv-bootstrap \
			--tree "$(TEST_SOURCE_STAGE)" server.tests
	CCACHE_DISABLE="$(CCACHE_DISABLE)" "$(SERVER_TEST)"

server-protocol-test: $(SERVER)
	node scripts/test-server-protocol.mjs "$(SERVER)"

extension: npm-ci
	npm run compile

extension-test: npm-ci
	npm test

extension-host-test: $(SERVER) npm-ci
	npm run test:vscode

test: server-test server-protocol-test extension-test

package: $(SERVER) npm-ci
	@mkdir -p "$(VSIX_DIR)"
	npm run compile
	TITAN_REPO="$(abspath $(TITAN_REPO))" \
	TITAN_PREFIX="$(TITAN_PREFIX)" \
	./node_modules/.bin/vsce package --no-dependencies \
		--target "$(VSIX_TARGET)" --out "$(VSIX)"

inspect-server: $(SERVER)
	./scripts/inspect-server.sh "$(SERVER)"

plugin-validate:
	node scripts/validate-plugin.mjs

verify: test extension-host-test package inspect-server plugin-validate install-server-test
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
	test -f "$(SERVER_INSTALL_STAGE)/usr/local/share/doc/titan-language-server/LICENSES/openssl-LICENSE"

install-vsix: package
	code --install-extension "$(VSIX)" --force

clean:
	rm -rf -- "$(BUILD_ROOT)" "$(SERVER)" dist dist-test

clean-node:
	rm -rf -- node_modules .vscode-test
