import Guacamole from 'guacamole-common-js';
import { CockpitTunnel } from './cockpit-tunnel.js';
import { installServicePackages } from './package-install.js';
import './style.scss';

// DOM references
var connectBtn = document.getElementById('connect-btn');
var disconnectBtn = document.getElementById('disconnect-btn');
var fullscreenBtn = document.getElementById('fullscreen-btn');
var displayWrapper = document.getElementById('display-wrapper');
var displayContainer = document.getElementById('display-container');
var connectionPanel = document.getElementById('connection-panel');
var errorMessage = document.getElementById('error-message');
var usernameInput = document.getElementById('username');
var passwordInput = document.getElementById('password');
var portInput = document.getElementById('port');
var guacdStatusEl = document.getElementById('guacd-status');
var xrdpStatusEl = document.getElementById('xrdp-status');
var guacdToggleBtn = document.getElementById('guacd-toggle');
var xrdpToggleBtn = document.getElementById('xrdp-toggle');
var guacdInstallBtn = document.getElementById('guacd-install');
var xrdpInstallBtn = document.getElementById('xrdp-install');

// Paste dialog DOM references
var pasteBtn = document.getElementById('paste-btn');
var pasteDialog = document.getElementById('paste-dialog');
var pasteText = document.getElementById('paste-text');
var pasteDialogCancel = document.getElementById('paste-dialog-cancel');
var pasteDialogSend = document.getElementById('paste-dialog-send');

// Install dialog DOM references
var installDialog = document.getElementById('install-dialog');
var installDialogTitle = document.getElementById('install-dialog-title');
var installDialogMessage = document.getElementById('install-dialog-message');
var installProgressBar = document.getElementById('install-progress-bar');
var installDialogError = document.getElementById('install-dialog-error');
var installDialogClose = document.getElementById('install-dialog-close');

// Configure dialog DOM references
var configureBtn = document.getElementById('configure-btn');
var configureDialog = document.getElementById('configure-dialog');
var configureLoading = document.getElementById('configure-loading');
var configureContent = document.getElementById('configure-content');
var configureError = document.getElementById('configure-error');
var configureCancel = document.getElementById('configure-cancel');
var configureApply = document.getElementById('configure-apply');
var configXrdpEnabled = document.getElementById('config-xrdp-enabled');
var configGuacdEnabled = document.getElementById('config-guacd-enabled');
var configXrdpEnabledStatus = document.getElementById('config-xrdp-enabled-status');
var configGuacdEnabledStatus = document.getElementById('config-guacd-enabled-status');
var configUsernameDisplay = document.getElementById('config-username-display');
var configGroupsCurrent = document.getElementById('config-groups-current');
var configAddGroups = document.getElementById('config-add-groups');
var configGroupsStatus = document.getElementById('config-groups-status');
var configMaxDisconnectTime = document.getElementById('config-max-disconnect-time');
var configDisconnectStatus = document.getElementById('config-disconnect-status');
var configXrdpPort = document.getElementById('config-xrdp-port');
var configXrdpPortStatus = document.getElementById('config-xrdp-port-status');

var client = null;
var tunnel = null;
var keyboard = null;
var mouse = null;

// Track current service states: 'active', 'inactive', 'not-installed'
var serviceStates = {
    guacd: null,
    xrdp: null
};

// ── Service management ──────────────────────────────────────────────

function checkServiceStatus(serviceName, statusEl, toggleBtn, installBtn) {
    cockpit.spawn(['systemctl', 'show', serviceName, '--property=LoadState,ActiveState'])
        .then(function(output) {
            var props = {};
            output.trim().split('\n').forEach(function(line) {
                var eq = line.indexOf('=');
                if (eq !== -1)
                    props[line.substring(0, eq)] = line.substring(eq + 1);
            });

            if (props.LoadState === 'not-found') {
                // Service unit not found — package not installed
                statusEl.textContent = serviceName;
                statusEl.className = 'status-indicator status-inactive';
                toggleBtn.classList.add('hidden');
                installBtn.classList.remove('hidden');
                installBtn.disabled = false;
                serviceStates[serviceName] = 'not-installed';
            } else if (props.ActiveState === 'active') {
                statusEl.textContent = serviceName;
                statusEl.className = 'status-indicator status-active';
                toggleBtn.innerHTML = '<span id="' + serviceName + '-status" class="status-indicator">' + serviceName + '</span><i class="fa-solid fa-stop" aria-hidden="true"></i>'
                // toggleBtn.textContent = 'Stop';
                toggleBtn.disabled = false;
                toggleBtn.classList.remove('hidden');
                installBtn.classList.add('hidden');
                serviceStates[serviceName] = 'active';
            } else {
                statusEl.textContent = serviceName;
                statusEl.className = 'status-indicator status-inactive';
                toggleBtn.innerHTML = '<span id="' + serviceName + '-status" class="status-indicator">' + serviceName + '</span><i class="fa-solid fa-play" aria-hidden="true"></i>'
                // toggleBtn.textContent = 'Start';
                toggleBtn.disabled = false;
                toggleBtn.classList.remove('hidden');
                installBtn.classList.add('hidden');
                serviceStates[serviceName] = 'inactive';
            }
        })
        .catch(function() {
            statusEl.textContent = serviceName + ': not installed';
            statusEl.className = 'status-indicator status-inactive';
            toggleBtn.classList.add('hidden');
            installBtn.classList.remove('hidden');
            installBtn.disabled = false;
            serviceStates[serviceName] = 'not-installed';
        });
}

function toggleService(serviceName, statusEl, toggleBtn, installBtn) {
    var action = serviceStates[serviceName] === 'active' ? 'stop' : 'start';
    toggleBtn.disabled = true;
    //toggleBtn.textContent = action === 'start' ? 'Starting...' : 'Stopping...';
    toggleBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';

    cockpit.spawn(['systemctl', action, serviceName], { superuser: 'require', err: 'message' })
        .then(function() {
            checkServiceStatus(serviceName, statusEl, toggleBtn, installBtn);
        })
        .catch(function(err) {
            showError('Failed to ' + action + ' ' + serviceName + ': ' + (err.message || err));
            checkServiceStatus(serviceName, statusEl, toggleBtn, installBtn);
        });
}

function checkAllServices() {
    checkServiceStatus('guacd', guacdStatusEl, guacdToggleBtn, guacdInstallBtn);
    checkServiceStatus('xrdp', xrdpStatusEl, xrdpToggleBtn, xrdpInstallBtn);
}

guacdToggleBtn.addEventListener('click', function() {
    toggleService('guacd', guacdStatusEl, guacdToggleBtn, guacdInstallBtn);
});

xrdpToggleBtn.addEventListener('click', function() {
    toggleService('xrdp', xrdpStatusEl, xrdpToggleBtn, xrdpInstallBtn);
});

// ── Package installation ────────────────────────────────────────────

function showInstallDialog(serviceName) {
    installDialogTitle.textContent = 'Installing ' + serviceName;
    installDialogMessage.textContent = 'Resolving packages...';
    installProgressBar.style.width = '0%';
    installDialogError.classList.add('hidden');
    installDialogError.textContent = '';
    installDialogClose.classList.add('hidden');
    installDialog.classList.remove('hidden');

    installServicePackages(serviceName, function(progress) {
        if (progress.message) {
            installDialogMessage.textContent = progress.message;
        }
        if (progress.percentage !== undefined && progress.percentage <= 100) {
            installProgressBar.style.width = progress.percentage + '%';
        }
    })
    .then(function(result) {
        if (result === 'already-installed') {
            installDialogMessage.textContent = serviceName + ' is already installed.';
        } else {
            installDialogMessage.textContent = serviceName + ' installed successfully.';
            installProgressBar.style.width = '100%';
        }
        installDialogClose.classList.remove('hidden');
        checkAllServices();
    })
    .catch(function(err) {
        installDialogMessage.textContent = 'Installation failed.';
        installDialogError.textContent = err.message || String(err);
        installDialogError.classList.remove('hidden');
        installDialogClose.classList.remove('hidden');
    });
}

guacdInstallBtn.addEventListener('click', function() {
    showInstallDialog('guacd');
});

xrdpInstallBtn.addEventListener('click', function() {
    showInstallDialog('xrdp');
});

installDialogClose.addEventListener('click', function() {
    installDialog.classList.add('hidden');
});

// ── Connection management ───────────────────────────────────────────

function doConnect() {
    var username = usernameInput.value.trim();
    var password = passwordInput.value;
    var port = parseInt(portInput.value) || 3389;

    if (!username) {
        showError('Username is required.');
        return;
    }

    hideError();

    // Compute display dimensions from the container
    var containerWidth = displayContainer.clientWidth || window.innerWidth;
    var containerHeight = displayContainer.clientHeight || (window.innerHeight - 100);

    var settings = {
        protocol: 'rdp',
        hostname: 'localhost',
        port: port,
        username: username,
        password: password,
        guacdPort: 4822,
        width: containerWidth,
        height: containerHeight,
        dpi: window.devicePixelRatio ? Math.round(96 * window.devicePixelRatio) : 96,
        security: 'any',
        ignoreCert: true,
        enableFontSmoothing: true,
        resizeMethod: 'display-update'
    };

    // Create tunnel
    tunnel = new CockpitTunnel();
    tunnel.setConnectionSettings(settings);

    // Create client
    client = new Guacamole.Client(tunnel);

    // State change handler
    client.onstatechange = function(state) {
        switch (state) {
            case Guacamole.Client.State.IDLE:
                setUIState('disconnected');
                break;
            case Guacamole.Client.State.CONNECTING:
            case Guacamole.Client.State.WAITING:
                setUIState('connecting');
                break;
            case Guacamole.Client.State.CONNECTED:
                setUIState('connected');
                break;
            case Guacamole.Client.State.DISCONNECTING:
            case Guacamole.Client.State.DISCONNECTED:
                setUIState('disconnected');
                break;
        }
    };

    // Error handler
    client.onerror = function(status) {
        showError('Connection error: ' + (status.message || 'Unknown error') +
                  ' (code: 0x' + status.code.toString(16) + ')');
    };

    // Get display and attach to container
    var display = client.getDisplay();
    var displayElement = display.getElement();
    displayContainer.innerHTML = '';
    displayContainer.appendChild(displayElement);

    // Mouse input — attach to the display element
    mouse = new Guacamole.Mouse(displayElement);

    mouse.onEach(['mousedown', 'mousemove', 'mouseup'], function(e) {
        client.sendMouseState(e.state, true);
    });

    // Keyboard input — attach to the display container (tabindex="0")
    // so it only captures keys when the display area is focused
    keyboard = new Guacamole.Keyboard(displayContainer);

    keyboard.onkeydown = function(keysym) {
        client.sendKeyEvent(1, keysym);
    };

    keyboard.onkeyup = function(keysym) {
        client.sendKeyEvent(0, keysym);
    };

    // Auto-scale display when it resizes
    display.onresize = function(width, height) {
        scaleDisplay(display);
    };

    // Show the display area before connecting so dimensions are available
    setUIState('connecting');

    // Connect
    client.connect('');
}

function doDisconnect() {
    if (keyboard) {
        keyboard.onkeydown = null;
        keyboard.onkeyup = null;
        keyboard.reset();
        keyboard = null;
    }
    mouse = null;
    if (client) {
        client.disconnect();
        client = null;
    }
    tunnel = null;
    displayContainer.innerHTML = '';
    setUIState('disconnected');
}

function scaleDisplay(display) {
    var containerWidth = displayContainer.clientWidth;
    var containerHeight = displayContainer.clientHeight;
    var displayWidth = display.getWidth();
    var displayHeight = display.getHeight();

    if (displayWidth <= 0 || displayHeight <= 0)
        return;

    var scale = Math.min(
        containerWidth / displayWidth,
        containerHeight / displayHeight,
        1
    );
    display.scale(scale);
}

// ── UI state management ─────────────────────────────────────────────

function setUIState(state) {
    switch (state) {
        case 'disconnected':
            connectBtn.disabled = false;
            connectionPanel.classList.remove('hidden');
            displayWrapper.classList.add('hidden');
            break;
        case 'connecting':
            connectBtn.disabled = true;
            connectionPanel.classList.add('hidden');
            displayWrapper.classList.remove('hidden');
            break;
        case 'connected':
            connectBtn.disabled = true;
            connectionPanel.classList.add('hidden');
            displayWrapper.classList.remove('hidden');
            // Focus the display container so keyboard events are captured
            displayContainer.focus();
            break;
    }
}

function showError(msg) {
    errorMessage.textContent = msg;
    errorMessage.classList.remove('hidden');
    // Also show the connection panel if hidden
    connectionPanel.classList.remove('hidden');
    displayWrapper.classList.add('hidden');
    connectBtn.disabled = false;
}

function hideError() {
    errorMessage.textContent = '';
    errorMessage.classList.add('hidden');
}

// ── Event handlers ──────────────────────────────────────────────────

connectBtn.addEventListener('click', doConnect);
disconnectBtn.addEventListener('click', doDisconnect);

fullscreenBtn.addEventListener('click', function() {
    if (displayWrapper.requestFullscreen) {
        displayWrapper.requestFullscreen();
    }
});

// Handle window resize
window.addEventListener('resize', function() {
    if (client) {
        var display = client.getDisplay();
        scaleDisplay(display);

        // Notify server of new size
        client.sendSize(displayContainer.clientWidth, displayContainer.clientHeight);
    }
});

// Allow connecting with Enter key in the password field
passwordInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        doConnect();
    }
});

// ── Paste functionality ─────────────────────────────────────────────

function sendClipboardText(text) {
    if (!client) return;

    // Send text to remote clipboard via Guacamole clipboard stream
    var stream = client.createClipboardStream('text/plain');
    var writer = new Guacamole.StringWriter(stream);
    writer.sendText(text);
    writer.sendEnd();

    // Simulate Ctrl+V to paste on the remote side
    var KEYSYM_CTRL_L = 0xFFE3;
    var KEYSYM_V = 0x0076;

    setTimeout(function() {
        client.sendKeyEvent(1, KEYSYM_CTRL_L);
        client.sendKeyEvent(1, KEYSYM_V);
        client.sendKeyEvent(0, KEYSYM_V);
        client.sendKeyEvent(0, KEYSYM_CTRL_L);
    }, 100);
}

pasteBtn.addEventListener('click', function() {
    pasteText.value = '';
    pasteDialog.classList.remove('hidden');
    pasteText.focus();
});

pasteDialogCancel.addEventListener('click', function() {
    pasteDialog.classList.add('hidden');
    displayContainer.focus();
});

pasteDialogSend.addEventListener('click', function() {
    var text = pasteText.value;
    if (text) {
        sendClipboardText(text);
    }
    pasteDialog.classList.add('hidden');
    displayContainer.focus();
});

// Allow sending with Ctrl+Enter in the paste textarea
pasteText.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        pasteDialogSend.click();
    } else if (e.key === 'Escape') {
        pasteDialogCancel.click();
    }
});

// ── Configuration dialog ─────────────────────────────────────────────

function setConfigStatus(el, type, text) {
    el.textContent = text;
    el.className = 'config-status config-status-' + type;
}

function clearAllConfigStatuses() {
    [configXrdpEnabledStatus, configGuacdEnabledStatus,
     configGroupsStatus, configDisconnectStatus, configXrdpPortStatus].forEach(function(el) {
        el.textContent = '';
        el.className = 'config-status';
    });
}

function parseMaxDisconnectionTime(iniContents) {
    var lines = iniContents.split('\n');
    var inXvncSection = false;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();

        if (line.match(/^\[.*\]$/)) {
            inXvncSection = (line.toLowerCase() === '[xvnc]');
            continue;
        }

        if (!inXvncSection) continue;

        if (line === 'param=-MaxDisconnectionTime' || line === 'param=--MaxDisconnectionTime') {
            if (i + 1 < lines.length) {
                var match = lines[i + 1].trim().match(/^param=(\d+)$/);
                if (match) {
                    return parseInt(match[1], 10);
                }
            }
            return 0;
        }
    }
    return 0;
}

function updateMaxDisconnectionTime(iniContents, newValue) {
    var lines = iniContents.split('\n');
    var result = [];
    var inXvncSection = false;
    var foundAndReplaced = false;
    var i = 0;

    while (i < lines.length) {
        var trimmed = lines[i].trim();

        if (trimmed.match(/^\[.*\]$/)) {
            // Leaving [Xvnc] without finding the param — inject before the new section
            if (inXvncSection && !foundAndReplaced && newValue > 0) {
                result.push('param=-MaxDisconnectionTime');
                result.push('param=' + newValue);
                foundAndReplaced = true;
            }
            inXvncSection = (trimmed.toLowerCase() === '[xvnc]');
            result.push(lines[i]);
            i++;
            continue;
        }

        if (inXvncSection &&
            (trimmed === 'param=-MaxDisconnectionTime' || trimmed === 'param=--MaxDisconnectionTime')) {
            if (newValue > 0) {
                result.push('param=-MaxDisconnectionTime');
                // Skip old value line if it follows
                if (i + 1 < lines.length && lines[i + 1].trim().match(/^param=\d+$/)) {
                    i++;
                }
                result.push('param=' + newValue);
            } else {
                // Remove: skip flag line and value line
                if (i + 1 < lines.length && lines[i + 1].trim().match(/^param=\d+$/)) {
                    i++;
                }
            }
            foundAndReplaced = true;
            i++;
            continue;
        }

        result.push(lines[i]);
        i++;
    }

    // Reached end of file while still in [Xvnc] without finding the param
    if (inXvncSection && !foundAndReplaced && newValue > 0) {
        result.push('param=-MaxDisconnectionTime');
        result.push('param=' + newValue);
    }

    return result.join('\n');
}

function parseXrdpPort(iniContents) {
    var lines = iniContents.split('\n');
    var inGlobals = false;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();

        if (line.match(/^\[.*\]$/)) {
            inGlobals = (line.toLowerCase() === '[globals]');
            continue;
        }

        if (!inGlobals) continue;

        var match = line.match(/^port\s*=\s*(.+)$/i);
        if (match) {
            var val = parseInt(match[1].trim(), 10);
            return (val > 0 && val <= 65535) ? val : 3389;
        }
    }
    return 3389;
}

function updateXrdpPort(iniContents, newPort) {
    var lines = iniContents.split('\n');
    var result = [];
    var inGlobals = false;
    var foundAndReplaced = false;

    for (var i = 0; i < lines.length; i++) {
        var trimmed = lines[i].trim();

        if (trimmed.match(/^\[.*\]$/)) {
            if (inGlobals && !foundAndReplaced) {
                result.push('port=' + newPort);
                foundAndReplaced = true;
            }
            inGlobals = (trimmed.toLowerCase() === '[globals]');
            result.push(lines[i]);
            continue;
        }

        if (inGlobals && trimmed.match(/^port\s*=/i)) {
            result.push('port=' + newPort);
            foundAndReplaced = true;
            continue;
        }

        result.push(lines[i]);
    }

    if (inGlobals && !foundAndReplaced) {
        result.push('port=' + newPort);
    }

    return result.join('\n');
}

function loadConfigState() {
    configureLoading.classList.remove('hidden');
    configureContent.classList.add('hidden');
    configureError.classList.add('hidden');
    clearAllConfigStatuses();

    var promises = [];

    // 1. Check if xrdp is enabled at boot
    promises.push(
        cockpit.spawn(['systemctl', 'is-enabled', 'xrdp'])
            .then(function(output) { return output.trim() === 'enabled'; })
            .catch(function() { return false; })
    );

    // 2. Check if guacd is enabled at boot
    promises.push(
        cockpit.spawn(['systemctl', 'is-enabled', 'guacd'])
            .then(function(output) { return output.trim() === 'enabled'; })
            .catch(function() { return false; })
    );

    // 3. Get current user info
    promises.push(
        cockpit.user().then(function(userInfo) { return userInfo; })
    );

    // 4. Read sesman.ini for MaxDisconnectionTime
    promises.push(
        cockpit.spawn(['cat', '/etc/xrdp/sesman.ini'])
            .then(function(contents) { return contents; })
            .catch(function() { return null; })
    );

    // 5. Read xrdp.ini for listening port
    promises.push(
        cockpit.spawn(['cat', '/etc/xrdp/xrdp.ini'])
            .then(function(contents) { return contents; })
            .catch(function() { return null; })
    );

    Promise.all(promises).then(function(results) {
        var xrdpEnabled = results[0];
        var guacdEnabled = results[1];
        var userInfo = results[2];
        var sesmanContents = results[3];

        configXrdpEnabled.checked = xrdpEnabled;
        configGuacdEnabled.checked = guacdEnabled;

        var username = userInfo.name || '';
        configUsernameDisplay.textContent = username;

        if (username) {
            cockpit.spawn(['id', '-Gn', username])
                .then(function(output) {
                    var groups = output.trim().split(/\s+/);
                    var hasRender = groups.indexOf('render') !== -1;
                    var hasVideo = groups.indexOf('video') !== -1;

                    if (hasRender && hasVideo) {
                        configGroupsCurrent.textContent = 'Already in render and video groups.';
                        configAddGroups.disabled = true;
                        configAddGroups.textContent = 'Already Added';
                    } else {
                        var missing = [];
                        if (!hasRender) missing.push('render');
                        if (!hasVideo) missing.push('video');
                        configGroupsCurrent.textContent = 'Missing groups: ' + missing.join(', ');
                        configAddGroups.disabled = false;
                        configAddGroups.textContent = 'Add to Groups';
                    }
                })
                .catch(function() {
                    configGroupsCurrent.textContent = 'Could not check current groups.';
                    configAddGroups.disabled = false;
                    configAddGroups.textContent = 'Add to Groups';
                });
        }

        var maxDisconnectTime = 0;
        if (sesmanContents) {
            maxDisconnectTime = parseMaxDisconnectionTime(sesmanContents);
        }
        configMaxDisconnectTime.value = maxDisconnectTime;

        var xrdpIniContents = results[4];
        var xrdpPort = 3389;
        if (xrdpIniContents) {
            xrdpPort = parseXrdpPort(xrdpIniContents);
        }
        configXrdpPort.value = xrdpPort;
        portInput.value = xrdpPort;

        configureLoading.classList.add('hidden');
        configureContent.classList.remove('hidden');
    }).catch(function(err) {
        configureLoading.textContent = 'Failed to load settings: ' + (err.message || err);
    });
}

function applyConfiguration() {
    configureApply.disabled = true;
    configureApply.textContent = 'Applying...';
    clearAllConfigStatuses();
    configureError.classList.add('hidden');

    var operations = [];

    // 1. Enable/disable xrdp at boot
    var xrdpAction = configXrdpEnabled.checked ? 'enable' : 'disable';
    operations.push(
        cockpit.spawn(['systemctl', xrdpAction, 'xrdp'], { superuser: 'require', err: 'message' })
            .then(function() {
                setConfigStatus(configXrdpEnabledStatus, 'ok', 'Done');
            })
            .catch(function(err) {
                setConfigStatus(configXrdpEnabledStatus, 'err', 'Failed: ' + (err.message || err));
                throw err;
            })
    );

    // 2. Enable/disable guacd at boot
    var guacdAction = configGuacdEnabled.checked ? 'enable' : 'disable';
    operations.push(
        cockpit.spawn(['systemctl', guacdAction, 'guacd'], { superuser: 'require', err: 'message' })
            .then(function() {
                setConfigStatus(configGuacdEnabledStatus, 'ok', 'Done');
            })
            .catch(function(err) {
                setConfigStatus(configGuacdEnabledStatus, 'err', 'Failed: ' + (err.message || err));
                throw err;
            })
    );

    // 3. MaxDisconnectionTime in sesman.ini
    var newTimeout = parseInt(configMaxDisconnectTime.value, 10);
    if (isNaN(newTimeout) || newTimeout < 0) newTimeout = 0;

    operations.push(
        cockpit.spawn(['cat', '/etc/xrdp/sesman.ini'], { err: 'message' })
            .then(function(contents) {
                var updated = updateMaxDisconnectionTime(contents, newTimeout);
                return cockpit.file('/etc/xrdp/sesman.ini', { superuser: 'require' })
                    .replace(updated);
            })
            .then(function() {
                setConfigStatus(configDisconnectStatus, 'ok', 'Done');
            })
            .catch(function(err) {
                setConfigStatus(configDisconnectStatus, 'err', 'Failed: ' + (err.message || err));
                throw err;
            })
    );

    // 4. XRDP listening port in xrdp.ini
    var newPort = parseInt(configXrdpPort.value, 10);
    if (isNaN(newPort) || newPort < 1 || newPort > 65535) newPort = 3389;

    operations.push(
        cockpit.spawn(['cat', '/etc/xrdp/xrdp.ini'], { err: 'message' })
            .then(function(contents) {
                var updated = updateXrdpPort(contents, newPort);
                return cockpit.file('/etc/xrdp/xrdp.ini', { superuser: 'require' })
                    .replace(updated);
            })
            .then(function() {
                setConfigStatus(configXrdpPortStatus, 'ok', 'Done');
                portInput.value = newPort;
            })
            .catch(function(err) {
                setConfigStatus(configXrdpPortStatus, 'err', 'Failed: ' + (err.message || err));
                throw err;
            })
    );

    Promise.allSettled(operations).then(function(results) {
        var anyFailed = results.some(function(r) { return r.status === 'rejected'; });
        configureApply.disabled = false;
        configureApply.textContent = 'Apply';

        if (anyFailed) {
            configureError.textContent = 'Some settings could not be applied. See details above.';
            configureError.classList.remove('hidden');
        }
    });
}

configureBtn.addEventListener('click', function() {
    configureDialog.classList.remove('hidden');
    loadConfigState();
});

configureCancel.addEventListener('click', function() {
    configureDialog.classList.add('hidden');
});

configureApply.addEventListener('click', function() {
    applyConfiguration();
});

configAddGroups.addEventListener('click', function() {
    configAddGroups.disabled = true;
    configAddGroups.textContent = 'Adding...';
    setConfigStatus(configGroupsStatus, 'info', '');

    cockpit.user().then(function(userInfo) {
        var username = userInfo.name;
        if (!username) throw new Error('Could not determine username');

        return cockpit.spawn(
            ['usermod', '-aG', 'render,video', username],
            { superuser: 'require', err: 'message' }
        );
    })
    .then(function() {
        setConfigStatus(configGroupsStatus, 'ok', 'Done (logout required)');
        configAddGroups.textContent = 'Already Added';
        configGroupsCurrent.textContent = 'User added to render and video groups.';
    })
    .catch(function(err) {
        setConfigStatus(configGroupsStatus, 'err', 'Failed: ' + (err.message || err));
        configAddGroups.disabled = false;
        configAddGroups.textContent = 'Add to Groups';
    });
});

configureDialog.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        configureCancel.click();
    }
});

// Initialize
checkAllServices();
setInterval(checkAllServices, 30000);

// Set initial UI state
setUIState('disconnected');
