/**
 * config.js
 *
 * Gateway URL and WebSocket base, derived from the
 * optional ?gateway=http://... URL parameter.
 * Falls back to location.hostname for local development.
 */
"use strict";

(() => {

const params  = new URLSearchParams(location.search);

const host = location.hostname || "localhost";
const defaultGateway = `http://${host}:8080`;

/** Base URL of the Streamline-Bridge REST API, e.g. http://192.168.1.100:8080 */
const GATEWAY = params.get("gateway") || defaultGateway;

/** WebSocket base URL derived from GATEWAY */
const WS_BASE = GATEWAY.replace(/^http/, "ws");

window.NSXConfig = {
	GATEWAY,
	WS_BASE,
};
})();
