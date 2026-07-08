# kodi — local build & install (no npm registry required)
PKG := $(shell node -p "require('./package.json').name")

.DEFAULT_GOAL := help
.PHONY: help deps build build-board test typecheck lint check install uninstall reinstall dev clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

deps: ## Install dependencies (CLI + self-contained board)
	pnpm install
	pnpm -C board install

build-board: ## Build the self-contained board app and bundle it into board-dist/
	pnpm build:board

build: ## Build the board app (bundled into board-dist/) + compile the CLI to dist/
	pnpm build

test: ## Run the test suite
	pnpm test

typecheck: ## Type-check without emitting
	pnpm typecheck

lint: ## Lint (ESLint + Prettier check) across src/ + tests/
	pnpm lint

check: lint typecheck test ## Lint + type-check + test (lint first, fails cheap)

install: build ## Build board + CLI (board bundled into the package) and install kodi globally
	npm install -g .
	@echo "installed $(PKG) — run: kodi --help  ('kodi tickets serve' serves the bundled board)"

uninstall: ## Remove the globally installed kodi
	npm uninstall -g $(PKG)

reinstall: uninstall install ## Reinstall from local source

dev: ## Rebuild on change
	pnpm dev

clean: ## Remove build output and dependencies
	rm -rf dist board-dist node_modules
