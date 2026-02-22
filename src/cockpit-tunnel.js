import Guacamole from 'guacamole-common-js';

/**
 * A Guacamole.Tunnel implementation that connects directly to guacd
 * via Cockpit's channel API (payload: "stream"). This eliminates the
 * need for guacamole-lite or any other WebSocket proxy middleware.
 *
 * The tunnel handles the guacd protocol handshake internally:
 *   1. Sends "select" with the protocol type (rdp)
 *   2. Receives "args" listing expected parameter names
 *   3. Sends "size", "audio", "video", "image", "connect"
 *   4. Receives "ready" with a connection ID
 *
 * After the handshake, all instructions are relayed between
 * Guacamole.Client and guacd transparently.
 *
 * @constructor
 * @augments Guacamole.Tunnel
 */
export function CockpitTunnel() {

    Guacamole.Tunnel.call(this);

    var tunnel = this;

    /**
     * The cockpit channel connected to guacd.
     * @private
     * @type {object}
     */
    var channel = null;

    /**
     * Parser for incoming guacd data. Handles TCP stream fragmentation
     * by buffering partial instructions.
     * @private
     * @type {Guacamole.Parser}
     */
    var parser = null;

    /**
     * Connection settings to use during the guacd handshake.
     * Set via setConnectionSettings() before calling connect().
     * @private
     * @type {object}
     */
    var connectionSettings = null;

    /**
     * Whether the guacd handshake has completed (received "ready").
     * @private
     * @type {boolean}
     */
    var handshakeComplete = false;

    /**
     * Timeout ID for the receive timeout timer.
     * @private
     * @type {number}
     */
    var receiveTimeoutId = null;

    /**
     * Timeout ID for the unstable connection timer.
     * @private
     * @type {number}
     */
    var unstableTimeoutId = null;

    /**
     * Set connection settings before calling connect().
     * These are used during the guacd handshake to populate
     * the "connect" instruction.
     *
     * @param {!object} settings
     *     Connection settings object with properties like hostname,
     *     port, username, password, etc.
     */
    this.setConnectionSettings = function setConnectionSettings(settings) {
        connectionSettings = settings;
    };

    /**
     * Formats elements into a Guacamole protocol instruction string.
     * Each element is length-prefixed: "length.value", elements are
     * comma-separated, and the instruction terminates with ";".
     *
     * @private
     * @param {...*} elements
     *     The elements to format.
     * @returns {!string}
     *     The formatted instruction string.
     */
    function formatInstruction() {
        var message = '';
        for (var i = 0; i < arguments.length; i++) {
            var value = String(arguments[i]);
            if (i > 0) message += ',';
            message += value.length + '.' + value;
        }
        message += ';';
        return message;
    }

    /**
     * Sends raw instruction text to guacd through the cockpit channel.
     *
     * @private
     * @param {!string} data
     *     The raw instruction text to send.
     */
    function sendRaw(data) {
        if (channel && channel.valid) {
            channel.send(data);
        }
    }

    /**
     * Resets the receive timeout and unstable connection timers.
     * Called whenever data is received from guacd.
     *
     * @private
     */
    function resetTimers() {

        // Clear existing timers
        if (receiveTimeoutId) clearTimeout(receiveTimeoutId);
        if (unstableTimeoutId) clearTimeout(unstableTimeoutId);

        // Restore from unstable if needed
        if (tunnel.state === Guacamole.Tunnel.State.UNSTABLE)
            tunnel.setState(Guacamole.Tunnel.State.OPEN);

        // Set unstable warning timer
        if (tunnel.isConnected()) {
            unstableTimeoutId = setTimeout(function() {
                tunnel.setState(Guacamole.Tunnel.State.UNSTABLE);
            }, tunnel.unstableThreshold);
        }

        // Set hard receive timeout
        if (tunnel.isConnected()) {
            receiveTimeoutId = setTimeout(function() {
                closeTunnel(new Guacamole.Status(
                    Guacamole.Status.Code.UPSTREAM_TIMEOUT,
                    'Server timeout.'
                ));
            }, tunnel.receiveTimeout);
        }
    }

    /**
     * Clears all timers.
     *
     * @private
     */
    function clearTimers() {
        if (receiveTimeoutId) clearTimeout(receiveTimeoutId);
        if (unstableTimeoutId) clearTimeout(unstableTimeoutId);
        receiveTimeoutId = null;
        unstableTimeoutId = null;
    }

    /**
     * Closes the tunnel, reporting the given status. If the status
     * represents an error, the onerror handler is fired.
     *
     * @private
     * @param {!Guacamole.Status} status
     *     The status describing why the tunnel is closing.
     */
    function closeTunnel(status) {

        clearTimers();

        // Ignore if already closed
        if (tunnel.state === Guacamole.Tunnel.State.CLOSED)
            return;

        // Signal error if applicable
        if (status.isError() && tunnel.onerror)
            tunnel.onerror(status);

        // Mark as closed
        tunnel.setState(Guacamole.Tunnel.State.CLOSED);

        // Close the cockpit channel
        if (channel) {
            channel.close();
            channel = null;
        }
    }

    /**
     * Processes an instruction received from guacd. During the handshake
     * phase, this handles "args", "ready", and "error" instructions.
     * After the handshake, all instructions are forwarded to the
     * Guacamole.Client via the oninstruction callback.
     *
     * @private
     * @param {!string} opcode
     *     The instruction opcode.
     * @param {!string[]} params
     *     The instruction parameters.
     */
    function processInstruction(opcode, params) {

        if (!handshakeComplete) {

            // guacd sends "args" listing the parameter names it expects
            if (opcode === 'args') {
                sendHandshakeReply(params);
            }
            // guacd sends "ready" with a connection ID after successful handshake
            else if (opcode === 'ready') {
                handshakeComplete = true;

                if (params.length > 0)
                    tunnel.setUUID(params[0]);

                tunnel.setState(Guacamole.Tunnel.State.OPEN);
                resetTimers();
            }
            // guacd sends "error" if something went wrong
            else if (opcode === 'error') {
                var code = parseInt(params[1]) || Guacamole.Status.Code.SERVER_ERROR;
                closeTunnel(new Guacamole.Status(code, params[0] || 'Handshake error'));
            }

        } else {

            // Post-handshake: forward to Guacamole.Client
            if (tunnel.oninstruction)
                tunnel.oninstruction(opcode, params);

        }
    }

    /**
     * Sends the handshake reply to guacd after receiving the "args"
     * instruction. This sends size, audio, video, image, and connect
     * instructions with the appropriate connection parameters.
     *
     * @private
     * @param {!string[]} serverArgNames
     *     The parameter names from guacd's "args" instruction.
     */
    function sendHandshakeReply(serverArgNames) {

        var settings = connectionSettings;

        var width = settings.width || 1024;
        var height = settings.height || 768;
        var dpi = settings.dpi || 96;

        // Send size
        sendRaw(formatInstruction('size', String(width), String(height), String(dpi)));

        // Send supported audio mimetypes (none for now)
        sendRaw(formatInstruction('audio'));

        // Send supported video mimetypes (none)
        sendRaw(formatInstruction('video'));

        // Send supported image mimetypes
        sendRaw(formatInstruction('image', 'image/png', 'image/jpeg', 'image/webp'));

        // Build connect instruction args matching server's expected order.
        // Each value corresponds to the parameter name at the same index
        // in serverArgNames. Unknown parameters get empty string (safe default).
        var paramMap = {
            'hostname':                     settings.hostname || 'localhost',
            'port':                         String(settings.port || 3389),
            'domain':                        settings.domain || '',
            'username':                      settings.username || '',
            'password':                      settings.password || '',
            'width':                         String(width),
            'height':                        String(height),
            'dpi':                           String(dpi),
            'initial-program':               '',
            'color-depth':                   settings.colorDepth || '',
            'disable-audio':                 '',
            'enable-printing':               '',
            'printer-name':                  '',
            'enable-drive':                  '',
            'drive-name':                    '',
            'drive-path':                    '',
            'create-drive-path':             '',
            'disable-download':              '',
            'disable-upload':                '',
            'console':                       '',
            'console-audio':                 '',
            'server-layout':                 '',
            'security':                      settings.security || 'any',
            'ignore-cert':                   settings.ignoreCert !== false ? 'true' : '',
            'disable-auth':                  '',
            'remote-app':                    '',
            'remote-app-dir':                '',
            'remote-app-args':               '',
            'static-channels':               '',
            'client-name':                   'cockpit-guacamole',
            'enable-wallpaper':              '',
            'enable-theming':                '',
            'enable-font-smoothing':         settings.enableFontSmoothing !== false ? 'true' : '',
            'enable-full-window-drag':       '',
            'enable-desktop-composition':    '',
            'enable-menu-animations':        '',
            'disable-bitmap-caching':        '',
            'disable-offscreen-caching':     '',
            'disable-glyph-caching':         '',
            'preconnection-id':              '',
            'preconnection-blob':            '',
            'timezone':                      '',
            'enable-sftp':                   '',
            'sftp-hostname':                 '',
            'sftp-host-key':                 '',
            'sftp-port':                     '',
            'sftp-username':                 '',
            'sftp-password':                 '',
            'sftp-private-key':              '',
            'sftp-passphrase':               '',
            'sftp-directory':                '',
            'sftp-root-directory':           '',
            'sftp-server-alive-interval':    '',
            'recording-path':               '',
            'recording-name':               '',
            'recording-exclude-output':      '',
            'recording-exclude-mouse':       '',
            'recording-exclude-touch':       '',
            'recording-include-keys':        '',
            'create-recording-path':         '',
            'resize-method':                 settings.resizeMethod || 'display-update',
            'enable-audio-input':            '',
            'enable-touch':                  '',
            'read-only':                     '',
            'gateway-hostname':              '',
            'gateway-port':                  '',
            'gateway-domain':               '',
            'gateway-username':              '',
            'gateway-password':              '',
            'load-balance-info':             '',
            'disable-copy':                  '',
            'disable-paste':                 '',
            'force-lossless':                '',
            'normalize-clipboard':           '',
            'timeout':                       '',
        };

        var connectArgs = serverArgNames.map(function(argName) {
            // Handle protocol version negotiation (VERSION_x_x_x)
            if (argName.startsWith('VERSION_'))
                return argName;
            return paramMap[argName] !== undefined ? paramMap[argName] : '';
        });

        sendRaw(formatInstruction.apply(null, ['connect'].concat(connectArgs)));
    }

    /**
     * Connect to guacd via cockpit.channel.
     *
     * @param {string} [data]
     *     Unused — connection parameters are provided via
     *     setConnectionSettings() instead.
     */
    this.connect = function connect(data) {

        handshakeComplete = false;
        tunnel.setState(Guacamole.Tunnel.State.CONNECTING);

        // Create parser for incoming guacd data
        parser = new Guacamole.Parser();
        parser.oninstruction = processInstruction;

        // Open a raw TCP stream to guacd via cockpit-bridge
        channel = cockpit.channel({
            payload: 'stream',
            port: connectionSettings.guacdPort || 4822,
            binary: false
        });

        channel.addEventListener('message', function(event, data) {
            if (handshakeComplete)
                resetTimers();
            parser.receive(data);
        });

        channel.addEventListener('close', function(event, options) {
            var problem = options.problem || options.reason;
            if (problem && tunnel.state !== Guacamole.Tunnel.State.CLOSED) {
                closeTunnel(new Guacamole.Status(
                    Guacamole.Status.Code.SERVER_ERROR,
                    'Connection closed: ' + problem
                ));
            } else {
                closeTunnel(new Guacamole.Status(Guacamole.Status.Code.SUCCESS));
            }
        });

        // Send the initial "select" instruction to choose the RDP protocol.
        // cockpit.channel queues messages if the underlying connection
        // isn't ready yet, so this is safe to send immediately.
        sendRaw(formatInstruction('select', connectionSettings.protocol || 'rdp'));
    };

    /**
     * Send a Guacamole instruction through the tunnel.
     * Called by Guacamole.Client for mouse, keyboard, clipboard, etc.
     *
     * @param {...*} elements
     *     The elements of the instruction to send (opcode + params).
     */
    this.sendMessage = function sendMessage(elements) {

        // Do not send if not connected
        if (!tunnel.isConnected())
            return;

        // Do not send empty messages
        if (arguments.length === 0)
            return;

        sendRaw(formatInstruction.apply(null, arguments));
    };

    /**
     * Disconnect from guacd.
     */
    this.disconnect = function disconnect() {

        // Send disconnect instruction if possible
        if (tunnel.isConnected()) {
            try {
                sendRaw(formatInstruction('disconnect'));
            } catch (e) {
                // Ignore errors during disconnect
            }
        }

        closeTunnel(new Guacamole.Status(Guacamole.Status.Code.SUCCESS, 'Manually closed.'));
    };

}

CockpitTunnel.prototype = new Guacamole.Tunnel();
