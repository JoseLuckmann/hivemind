PNPM_VERSION := 10.12.2
PNPM := $(shell command -v pnpm 2>/dev/null || echo npx --yes pnpm@$(PNPM_VERSION))

.PHONY: run stop
run:
	$(PNPM) dev:desktop

stop:
	-pkill -f "electron-vite.js dev"
	-pkill -f "node_modules/electron/dist/electron"
	@true
