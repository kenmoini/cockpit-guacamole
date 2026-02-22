PACKAGE_NAME = cockpit-guacamole
INSTALL_DIR = $(HOME)/.local/share/cockpit/$(PACKAGE_NAME)

all: build

node_modules: package.json
	npm install

build: node_modules
	npm run build

watch: node_modules
	npm run watch

install: build
	mkdir -p $(INSTALL_DIR)
	cp -r dist/* $(INSTALL_DIR)/

devel-install: build
	mkdir -p $(HOME)/.local/share/cockpit
	ln -sfn $(CURDIR)/dist $(INSTALL_DIR)

clean:
	rm -rf dist node_modules

.PHONY: all build watch install devel-install clean
