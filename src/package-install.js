/**
 * PackageKit D-Bus integration for installing packages.
 *
 * Uses cockpit.dbus() to communicate with PackageKit, following the
 * same pattern as Cockpit's cockpit-components-install-dialog.jsx.
 *
 * Flow:
 *   1. CreateTransaction → transaction path
 *   2. Resolve(filter, packageNames) → Package signals (installed/available)
 *   3. CreateTransaction → new transaction path
 *   4. InstallPackages(0, packageIds) → Package/Finished/ErrorCode signals
 */

var PK_BUS = 'org.freedesktop.PackageKit';
var PK_PATH = '/org/freedesktop/PackageKit';
var PK_IFACE = 'org.freedesktop.PackageKit';
var PK_TRANS_IFACE = 'org.freedesktop.PackageKit.Transaction';

// Filter enum bit positions (PK_FILTER_ENUM_* → 1 << enum_value)
var PK_FILTER_NEWEST = 1 << 16;
var PK_FILTER_ARCH = 1 << 18;
var PK_FILTER_NOT_SOURCE = 1 << 21;

// Info enum values from PackageKit
var PK_INFO_INSTALLED = 1;

/**
 * Mapping of service names to candidate package names.
 * PackageKit Resolve will be used to find which names are valid
 * for the current distro.
 */
export var SERVICE_PACKAGES = {
    'guacd': {
        candidates: ['guacd', 'guacamole-server'],
        extras: ['libguac-client-rdp', 'libguac-client-rdp0'],
        description: 'Apache Guacamole proxy daemon'
    },
    'xrdp': {
        candidates: ['xrdp'],
        description: 'Open source RDP server'
    }
};

/**
 * Create a new PackageKit transaction.
 *
 * @param {object} pkClient - cockpit.dbus() client for PackageKit
 * @returns {Promise<string>} The transaction object path
 */
function createTransaction(pkClient) {
    return pkClient.call(PK_PATH, PK_IFACE, 'CreateTransaction', [])
        .then(function(result) { return result[0]; });
}

/**
 * Run a PackageKit transaction method and collect signals until Finished.
 *
 * @param {object} pkClient - cockpit.dbus() client
 * @param {string} method - Transaction method name (e.g., "Resolve", "InstallPackages")
 * @param {Array} args - Method arguments
 * @param {object} handlers - Signal handlers: { Package, ErrorCode, ItemProgress }
 * @returns {Promise} Resolves on Finished, rejects on ErrorCode
 */
function runTransaction(pkClient, method, args, handlers) {
    return createTransaction(pkClient).then(function(transPath) {
        return new Promise(function(resolve, reject) {
            var finished = false;
            var lastError = null;

            // Subscribe to signals BEFORE calling the method to avoid
            // missing early signals (race condition).
            var subscription = pkClient.subscribe(
                { path: transPath, interface: PK_TRANS_IFACE },
                function(path, iface, signal, signalArgs) {
                    if (finished) return;

                    if (signal === 'Package' && handlers.Package) {
                        handlers.Package(signalArgs);
                    }
                    else if (signal === 'ItemProgress' && handlers.ItemProgress) {
                        handlers.ItemProgress(signalArgs);
                    }
                    else if (signal === 'ErrorCode') {
                        // ErrorCode can arrive before Finished — save the
                        // error and reject when Finished arrives.
                        lastError = new Error(signalArgs[1] || 'PackageKit error');
                    }
                    else if (signal === 'Finished') {
                        finished = true;
                        subscription.remove();
                        if (lastError)
                            reject(lastError);
                        else
                            resolve();
                    }
                }
            );

            // Use { type: "tas" } so cockpit.dbus() marshals the first
            // arg as uint64 (D-Bus type 't') instead of double ('d').
            // Without this, PackageKit rejects the call with InvalidArgs.
            pkClient.call(transPath, PK_TRANS_IFACE, method, args, { type: 'tas' })
                .catch(function(err) {
                    if (!finished) {
                        finished = true;
                        subscription.remove();
                        reject(err);
                    }
                });
        });
    });
}

/**
 * Resolve package names to determine which are installed, available,
 * or unavailable.
 *
 * @param {object} pkClient - cockpit.dbus() client for PackageKit
 * @param {string[]} packageNames - Package names to resolve
 * @returns {Promise<object>} { installed: [{name, id}], available: [{name, id}], unavailable: [string] }
 */
export function resolvePackages(pkClient, packageNames) {
    var result = { installed: [], available: [], unavailable: [] };
    var seenNames = {};

    var filter = PK_FILTER_NEWEST | PK_FILTER_ARCH | PK_FILTER_NOT_SOURCE;

    return runTransaction(pkClient, 'Resolve', [filter, packageNames], {
        Package: function(args) {
            var info = args[0];
            var packageId = args[1];
            var name = packageId.split(';')[0];

            // Only keep the first result per package name
            if (seenNames[name]) return;
            seenNames[name] = true;

            if (info === PK_INFO_INSTALLED) {
                result.installed.push({ name: name, id: packageId });
            } else {
                result.available.push({ name: name, id: packageId });
            }
        }
    }).then(function() {
        // Find names that weren't resolved at all
        packageNames.forEach(function(name) {
            if (!seenNames[name]) {
                result.unavailable.push(name);
            }
        });
        return result;
    });
}

/**
 * Install packages by their PackageKit IDs.
 *
 * @param {object} pkClient - cockpit.dbus() client for PackageKit
 * @param {string[]} packageIds - PackageKit package IDs to install
 * @param {function} [progressCallback] - Called with progress updates: { message: string, percentage: number }
 * @returns {Promise} Resolves when installation is complete
 */
export function installPackageIds(pkClient, packageIds, progressCallback) {
    return runTransaction(pkClient, 'InstallPackages', [0, packageIds], {
        Package: function(args) {
            var name = args[1].split(';')[0];
            if (progressCallback) {
                progressCallback({ message: 'Installing ' + name + '...' });
            }
        },
        ItemProgress: function(args) {
            var packageId = args[0];
            var percentage = args[1];
            var name = packageId.split(';')[0];
            if (progressCallback && percentage <= 100) {
                progressCallback({
                    message: 'Installing ' + name + '...',
                    percentage: percentage
                });
            }
        }
    });
}

/**
 * High-level function: resolve candidate package names for a service,
 * find which ones are available, and install them.
 *
 * @param {string} serviceName - Service name (key in SERVICE_PACKAGES)
 * @param {function} [progressCallback] - Progress callback
 * @returns {Promise} Resolves when installation is complete
 */
export function installServicePackages(serviceName, progressCallback) {
    var serviceInfo = SERVICE_PACKAGES[serviceName];
    if (!serviceInfo) {
        return Promise.reject(new Error('Unknown service: ' + serviceName));
    }

    var pkClient = cockpit.dbus(PK_BUS, { superuser: 'try' });

    if (progressCallback) {
        progressCallback({ message: 'Resolving packages...' });
    }

    // Resolve main candidates and extras (if any) in parallel
    var allNames = serviceInfo.candidates.slice();
    if (serviceInfo.extras) {
        allNames = allNames.concat(serviceInfo.extras);
    }

    return resolvePackages(pkClient, allNames)
        .then(function(resolved) {
            // Check if the main service package is already installed
            var mainInstalled = resolved.installed.some(function(pkg) {
                return serviceInfo.candidates.indexOf(pkg.name) !== -1;
            });
            if (mainInstalled) {
                // Still install any missing extras
                var extraIds = [];
                if (serviceInfo.extras) {
                    resolved.available.forEach(function(pkg) {
                        if (serviceInfo.extras.indexOf(pkg.name) !== -1) {
                            extraIds.push(pkg.id);
                        }
                    });
                }
                if (extraIds.length === 0) {
                    return Promise.resolve('already-installed');
                }
                if (progressCallback) {
                    progressCallback({ message: 'Installing additional packages...' });
                }
                return installPackageIds(pkClient, extraIds, progressCallback);
            }

            // Find the first available main candidate
            var mainAvailable = null;
            for (var i = 0; i < resolved.available.length; i++) {
                if (serviceInfo.candidates.indexOf(resolved.available[i].name) !== -1) {
                    mainAvailable = resolved.available[i];
                    break;
                }
            }

            if (!mainAvailable) {
                var msg = 'Package not found. Tried: ' + serviceInfo.candidates.join(', ') + '. ';
                if (resolved.unavailable.length > 0) {
                    msg += 'You may need to enable additional repositories (e.g., EPEL).';
                }
                return Promise.reject(new Error(msg));
            }

            // Collect main package + any available extras
            var toInstall = [mainAvailable.id];
            if (serviceInfo.extras) {
                resolved.available.forEach(function(pkg) {
                    if (serviceInfo.extras.indexOf(pkg.name) !== -1) {
                        toInstall.push(pkg.id);
                    }
                });
            }

            if (progressCallback) {
                var names = toInstall.map(function(id) { return id.split(';')[0]; });
                progressCallback({ message: 'Installing ' + names.join(', ') + '...' });
            }

            return installPackageIds(pkClient, toInstall, progressCallback);
        })
        .finally(function() {
            pkClient.close();
        });
}
