/**
 * Package installation for Cockpit plugin.
 *
 * Supports two backends:
 *   1. PackageKit D-Bus (preferred, used when available)
 *   2. Native package manager fallback (apt-get / dnf / yum)
 *
 * PackageKit flow:
 *   CreateTransaction -> Resolve -> CreateTransaction -> InstallPackages
 *
 * Native fallback flow:
 *   detectPackageManager -> resolve via apt-cache/rpm -> install via apt-get/dnf/yum
 */

// ── PackageKit constants ─────────────────────────────────────────────

var PK_BUS = 'org.freedesktop.PackageKit';
var PK_PATH = '/org/freedesktop/PackageKit';
var PK_IFACE = 'org.freedesktop.PackageKit';
var PK_TRANS_IFACE = 'org.freedesktop.PackageKit.Transaction';

// Filter enum bit positions (PK_FILTER_ENUM_* -> 1 << enum_value)
var PK_FILTER_NEWEST = 1 << 16;
var PK_FILTER_ARCH = 1 << 18;
var PK_FILTER_NOT_SOURCE = 1 << 21;

// Info enum values from PackageKit
var PK_INFO_INSTALLED = 1;

// ── Detection cache ──────────────────────────────────────────────────

var _packageKitAvailable = null;   // null = not checked, true/false after
var _nativePMChecked = false;
var _nativePackageManager = null;  // 'apt' | 'dnf' | 'yum' | null

// ── Service package mapping ──────────────────────────────────────────

/**
 * Mapping of service names to candidate package names.
 * Resolve will find which names are valid for the current distro.
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

// ── Detection functions ──────────────────────────────────────────────

/**
 * Detect whether PackageKit is installed by checking its systemd unit.
 * Result is cached after the first call.
 *
 * @returns {Promise<boolean>}
 */
function detectPackageKit() {
    if (_packageKitAvailable !== null) {
        return Promise.resolve(_packageKitAvailable);
    }

    return cockpit.spawn(
        ['systemctl', 'show', 'packagekit.service', '--property=LoadState'],
        { err: 'message' }
    )
    .then(function(output) {
        _packageKitAvailable = (output.trim() !== 'LoadState=not-found');
        return _packageKitAvailable;
    })
    .catch(function() {
        _packageKitAvailable = false;
        return false;
    });
}

/**
 * Detect the native package manager (apt-get, dnf, or yum).
 * Result is cached after the first call.
 *
 * @returns {Promise<string|null>} 'apt' | 'dnf' | 'yum' | null
 */
function detectNativePackageManager() {
    if (_nativePMChecked) {
        return Promise.resolve(_nativePackageManager);
    }

    var managers = [
        { name: 'apt', cmd: ['apt-get', '--version'] },
        { name: 'dnf', cmd: ['dnf', '--version'] },
        { name: 'yum', cmd: ['yum', '--version'] }
    ];

    var chain = Promise.reject();
    managers.forEach(function(mgr) {
        chain = chain.catch(function() {
            return cockpit.spawn(mgr.cmd, { err: 'ignore' })
                .then(function() { return mgr.name; });
        });
    });

    return chain
        .then(function(name) {
            _nativePMChecked = true;
            _nativePackageManager = name;
            return name;
        })
        .catch(function() {
            _nativePMChecked = true;
            _nativePackageManager = null;
            return null;
        });
}

// ── PackageKit backend ───────────────────────────────────────────────

function createTransaction(pkClient) {
    return pkClient.call(PK_PATH, PK_IFACE, 'CreateTransaction', [])
        .then(function(result) { return result[0]; });
}

function runTransaction(pkClient, method, args, handlers) {
    return createTransaction(pkClient).then(function(transPath) {
        return new Promise(function(resolve, reject) {
            var finished = false;
            var lastError = null;

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

export function resolvePackages(pkClient, packageNames) {
    var result = { installed: [], available: [], unavailable: [] };
    var seenNames = {};

    var filter = PK_FILTER_NEWEST | PK_FILTER_ARCH | PK_FILTER_NOT_SOURCE;

    return runTransaction(pkClient, 'Resolve', [filter, packageNames], {
        Package: function(args) {
            var info = args[0];
            var packageId = args[1];
            var name = packageId.split(';')[0];

            if (seenNames[name]) return;
            seenNames[name] = true;

            if (info === PK_INFO_INSTALLED) {
                result.installed.push({ name: name, id: packageId });
            } else {
                result.available.push({ name: name, id: packageId });
            }
        }
    }).then(function() {
        packageNames.forEach(function(name) {
            if (!seenNames[name]) {
                result.unavailable.push(name);
            }
        });
        return result;
    });
}

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
 * Install service packages via PackageKit D-Bus.
 */
function installServicePackagesPK(serviceName, progressCallback) {
    var serviceInfo = SERVICE_PACKAGES[serviceName];
    var pkClient = cockpit.dbus(PK_BUS, { superuser: 'try' });

    if (progressCallback) {
        progressCallback({ message: 'Resolving packages...' });
    }

    var allNames = serviceInfo.candidates.slice();
    if (serviceInfo.extras) {
        allNames = allNames.concat(serviceInfo.extras);
    }

    return resolvePackages(pkClient, allNames)
        .then(function(resolved) {
            var mainInstalled = resolved.installed.some(function(pkg) {
                return serviceInfo.candidates.indexOf(pkg.name) !== -1;
            });
            if (mainInstalled) {
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

// ── Native package manager backend ───────────────────────────────────

/**
 * Resolve package availability using apt-cache policy.
 * Runs apt-get update first to ensure the cache is fresh.
 */
function nativeResolveApt(packageNames) {
    var result = { installed: [], available: [], unavailable: [] };

    return cockpit.spawn(['apt-get', 'update'], { superuser: 'try', err: 'ignore' })
        .catch(function() { /* ignore update failures */ })
        .then(function() {
            return cockpit.spawn(
                ['apt-cache', 'policy'].concat(packageNames),
                { err: 'ignore' }
            );
        })
        .catch(function() { return ''; })
        .then(function(output) {
            var currentPkg = null;
            var installed = null;
            var candidate = null;

            output.split('\n').forEach(function(line) {
                var pkgMatch = line.match(/^(\S+):$/);
                if (pkgMatch) {
                    if (currentPkg) {
                        classifyAptPackage(currentPkg, installed, candidate, result);
                    }
                    currentPkg = pkgMatch[1];
                    installed = null;
                    candidate = null;
                    return;
                }
                var instMatch = line.match(/^\s+Installed:\s+(.+)$/);
                if (instMatch) {
                    installed = instMatch[1].trim();
                    return;
                }
                var candMatch = line.match(/^\s+Candidate:\s+(.+)$/);
                if (candMatch) {
                    candidate = candMatch[1].trim();
                }
            });

            if (currentPkg) {
                classifyAptPackage(currentPkg, installed, candidate, result);
            }

            // Mark names not seen in output as unavailable
            var seen = {};
            result.installed.concat(result.available).concat(result.unavailable)
                .forEach(function(name) { seen[name] = true; });
            packageNames.forEach(function(name) {
                if (!seen[name]) {
                    result.unavailable.push(name);
                }
            });

            return result;
        });
}

function classifyAptPackage(name, installed, candidate, result) {
    if (installed && installed !== '(none)') {
        result.installed.push(name);
    } else if (candidate && candidate !== '(none)') {
        result.available.push(name);
    } else {
        result.unavailable.push(name);
    }
}

/**
 * Resolve package availability using rpm and dnf/yum.
 */
function nativeResolveDnfYum(pmType, packageNames) {
    var result = { installed: [], available: [], unavailable: [] };
    var cmd = pmType === 'dnf' ? 'dnf' : 'yum';

    return cockpit.spawn(['rpm', '-q'].concat(packageNames), { err: 'ignore' })
        .catch(function() { return ''; })
        .then(function(rpmOutput) {
            var installedSet = {};
            rpmOutput.trim().split('\n').forEach(function(line) {
                if (line && line.indexOf('not installed') === -1) {
                    packageNames.forEach(function(name) {
                        if (line.indexOf(name + '-') === 0 || line === name) {
                            installedSet[name] = true;
                        }
                    });
                }
            });

            var notInstalled = packageNames.filter(function(name) {
                return !installedSet[name];
            });

            if (notInstalled.length === 0) {
                packageNames.forEach(function(name) {
                    result.installed.push(name);
                });
                return result;
            }

            return cockpit.spawn(
                [cmd, 'info', '--available'].concat(notInstalled),
                { err: 'ignore' }
            )
            .catch(function() { return ''; })
            .then(function(infoOutput) {
                var availableSet = {};
                infoOutput.split('\n').forEach(function(line) {
                    var match = line.match(/^Name\s*:\s*(.+)/);
                    if (match) {
                        availableSet[match[1].trim()] = true;
                    }
                });

                packageNames.forEach(function(name) {
                    if (installedSet[name]) {
                        result.installed.push(name);
                    } else if (availableSet[name]) {
                        result.available.push(name);
                    } else {
                        result.unavailable.push(name);
                    }
                });

                return result;
            });
        });
}

function nativeResolvePackages(pmType, packageNames) {
    if (pmType === 'apt') {
        return nativeResolveApt(packageNames);
    }
    return nativeResolveDnfYum(pmType, packageNames);
}

/**
 * Install packages using the native package manager.
 */
function nativeInstallPackages(pmType, packageNames, progressCallback) {
    var cmd;
    if (pmType === 'apt') {
        cmd = ['apt-get', 'install', '-y'].concat(packageNames);
    } else if (pmType === 'dnf') {
        cmd = ['dnf', 'install', '-y'].concat(packageNames);
    } else {
        cmd = ['yum', 'install', '-y'].concat(packageNames);
    }

    if (progressCallback) {
        progressCallback({ message: 'Installing ' + packageNames.join(', ') + '...' });
    }

    return cockpit.spawn(cmd, { superuser: 'require', err: 'message' });
}

/**
 * Install service packages using the native package manager.
 * Mirrors the PackageKit high-level logic with native resolve + install.
 */
function nativeInstallServicePackages(pmType, serviceName, progressCallback) {
    var serviceInfo = SERVICE_PACKAGES[serviceName];

    var allNames = serviceInfo.candidates.slice();
    if (serviceInfo.extras) {
        allNames = allNames.concat(serviceInfo.extras);
    }

    if (progressCallback) {
        progressCallback({ message: 'Checking package availability...' });
    }

    return nativeResolvePackages(pmType, allNames)
        .then(function(resolved) {
            var mainInstalled = resolved.installed.some(function(name) {
                return serviceInfo.candidates.indexOf(name) !== -1;
            });

            if (mainInstalled) {
                var extraToInstall = [];
                if (serviceInfo.extras) {
                    resolved.available.forEach(function(name) {
                        if (serviceInfo.extras.indexOf(name) !== -1) {
                            extraToInstall.push(name);
                        }
                    });
                }
                if (extraToInstall.length === 0) {
                    return 'already-installed';
                }
                if (progressCallback) {
                    progressCallback({ message: 'Installing additional packages...' });
                }
                return nativeInstallPackages(pmType, extraToInstall, progressCallback);
            }

            var mainAvailable = null;
            for (var i = 0; i < resolved.available.length; i++) {
                if (serviceInfo.candidates.indexOf(resolved.available[i]) !== -1) {
                    mainAvailable = resolved.available[i];
                    break;
                }
            }

            if (!mainAvailable) {
                var msg = 'Package not found. Tried: ' + serviceInfo.candidates.join(', ') + '. ';
                if (resolved.unavailable.length > 0) {
                    msg += 'You may need to enable additional repositories.';
                }
                return Promise.reject(new Error(msg));
            }

            var toInstall = [mainAvailable];
            if (serviceInfo.extras) {
                resolved.available.forEach(function(name) {
                    if (serviceInfo.extras.indexOf(name) !== -1) {
                        toInstall.push(name);
                    }
                });
            }

            if (progressCallback) {
                progressCallback({ message: 'Installing ' + toInstall.join(', ') + '...' });
            }

            return nativeInstallPackages(pmType, toInstall, progressCallback);
        });
}

// ── Public entry point ───────────────────────────────────────────────

/**
 * High-level function: resolve candidate package names for a service,
 * find which ones are available, and install them.
 *
 * Detects whether to use PackageKit or the native package manager.
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

    return detectPackageKit().then(function(pkAvailable) {
        if (pkAvailable) {
            return installServicePackagesPK(serviceName, progressCallback);
        }

        return detectNativePackageManager().then(function(pmType) {
            if (!pmType) {
                return Promise.reject(new Error(
                    'No supported package manager found. ' +
                    'Install PackageKit, or ensure apt-get, dnf, or yum is available.'
                ));
            }
            return nativeInstallServicePackages(pmType, serviceName, progressCallback);
        });
    });
}
