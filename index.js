"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const dgram = require("dgram");
const crypto = require("crypto");
const { spawn } = require("child_process");

const CONFIG_FILE = path.join(__dirname, "config.json");
const IMAGE_PORT = 47122;
const POLL_MS = 5000;
// Playback advances by about one poll interval between polls; dragging the timeline
// jumps much further, or backwards. Anything past this is treated as a manual seek.
const SEEK_TOLERANCE = 5;
const SERVICE = "urn:schemas-upnp-org:service:AVTransport:1";

// --- Pure parsing helpers (exported for tests) ---

// Entities arrive doubly encoded: TrackMetaData is an escaped XML document, and the
// text inside it was escaped once more before that. &amp; is decoded last, otherwise
// "&amp;lt;" would turn into a "<" that was never in the original text.
function decode(s) {
    return s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

function tag(xml, name) {
    const m = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">").exec(xml);
    return m ? m[1] : undefined;
}

function hms(value) {
    if (!value) return 0;
    const parts = value.split(":").map(Number);
    if (parts.some(isNaN)) return 0;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// upnp:artist repeats for multi-artist tracks and dc:creator is not always present,
// so fall back through both rather than trusting either one alone.
function parseTrack(positionInfoXml) {
    const didl = decode(tag(positionInfoXml, "TrackMetaData") || "");
    const field = (name) => {
        const v = tag(didl, name);
        return v ? decode(v).trim() : undefined;
    };
    const uri = tag(positionInfoXml, "TrackURI");
    const title = field("dc:title");
    if (!title) return null;
    return {
        title,
        artist: field("upnp:artist") || field("dc:creator"),
        album: field("upnp:album"),
        art: field("upnp:albumArtURI"),
        duration: hms(tag(positionInfoXml, "TrackDuration")),
        position: hms(tag(positionInfoXml, "RelTime")),
        // TrackURI, not the title: the same title can repeat across an album (hidden
        // tracks, multi-disc rips) and repeating a track must still count as a change.
        id: uri || title,
    };
}

// Discord rejects the whole SET_ACTIVITY payload if details/state/largeImageText is
// 1 character or longer than 128 - the update is dropped and nothing appears. Both
// ends occur in a real library: single-character CJK titles, and classical track
// names that run well past 128 characters.
function formatLine(line) {
    if (!line) return undefined;
    if (line.length === 1) return line + " ";
    return line.slice(0, 128);
}

// MinimServer advertises the embedded picture of the album's first track, which 404s
// for albums whose art sits beside the files as an image instead of inside them - so
// the folder image is tried next rather than giving up on a broken advertised URL.
function artCandidates(track) {
    const dir = /^https?:/.test(track.id) ? track.id.replace(/\/[^/]*$/, "") : null;
    return [track.art, dir && dir + "/cover.jpg", dir && dir + "/folder.jpg"].filter(Boolean);
}

// A renderer's own description document is the only place its friendly name appears,
// and the control URL in it may be relative to where the document was fetched from.
function parseDescription(xml, location) {
    const service = (xml.match(/<service>[\s\S]*?<\/service>/g) || []).find((s) =>
        (tag(s, "serviceType") || "").includes("AVTransport")
    );
    if (!service) return null;
    return {
        name: (tag(xml, "friendlyName") || "").trim(),
        control: new URL((tag(service, "controlURL") || "").trim(), location).href,
    };
}

// Substring rather than equality: a friendly name usually carries a serial number the
// owner has no reason to type out. An empty name matches everything, which takes the
// first renderer that answers - the right behaviour on a one-streamer network.
function matchRenderer(renderers, wanted) {
    const needle = (wanted || "").trim().toLowerCase();
    return renderers.find((r) => r.name.toLowerCase().includes(needle)) || null;
}

// How far the renderer's position has drifted from what Discord is already showing.
// Infinity for a different track, which always needs a new payload.
function presenceDrift(current, next, now) {
    if (!current || current.id !== next.id) return Infinity;
    return Math.abs(next.position - (current.position + (now - current.at) / 1000));
}

module.exports = { decode, tag, hms, parseTrack, formatLine, artCandidates, parseDescription, matchRenderer, presenceDrift };

if (require.main !== module) return;

// --- Daemon ---

// Listing runs before anything else is set up: it needs no config, no Discord and no
// ports, and its output is read by a person rather than tailed from a log.
if (process.argv.includes("--list")) {
    listRenderers();
    return;
}

const origLog = console.log;
const origError = console.error;
console.log = (...args) => origLog(new Date().toISOString(), ...args);
console.error = (...args) => origError(new Date().toISOString(), ...args);

console.log("UPnP Discord Presence starting, pid " + process.pid);

const { Client: DiscordClient } = require("@xhayper/discord-rpc");
const { ActivityType } = require("discord-api-types/v10");

let config;
try {
    // The BOM strip is for editors that save UTF-8 with one and make JSON.parse throw
    // on a file the user has no reason to think is wrong.
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, ""));
} catch (err) {
    console.error("Could not read " + CONFIG_FILE + " - " + err.message);
    console.error("It must sit next to index.js and hold your Discord Application ID (see README.md).");
    process.exit(1);
}

if (!config.discordClientId || config.discordClientId === "YOUR_DISCORD_APPLICATION_ID") {
    console.error("Set discordClientId in config.json first (see README.md).");
    process.exit(1);
}

let discordReady = false;
let rpc;

// discord-rpc clients cache their connect() promise forever (even on failure), so
// reusing one Client across retries would make every retry after the first a no-op.
function connectDiscord() {
    rpc = new DiscordClient({ clientId: config.discordClientId, transport: "ipc" });

    rpc.on("ready", () => {
        discordReady = true;
        console.log("Connected to Discord.");
        pushPresence();
    });

    rpc.on("disconnected", () => {
        discordReady = false;
        console.log("Discord connection closed, reconnecting in 15s...");
        setTimeout(connectDiscord, 15000);
    });

    rpc.login().catch((err) => {
        console.error("Discord connect failed, retrying in 15s:", err.message);
        setTimeout(connectDiscord, 15000);
    });
}

// --- Cover art: the album art lives on the NAS at a LAN address Discord's client
// cannot reach, so cache the bytes locally and expose them through a cloudflared
// tunnel, which is the public URL handed to Discord.
const IMAGE_CACHE_MAX = 10;
const images = new Map(); // key -> { buffer, contentType } | null
let tunnelUrl = null;

const imageServer = http.createServer((req, res) => {
    const key = new URL(req.url, "http://127.0.0.1").searchParams.get("k");
    const img = key && images.get(key);
    if (!img) {
        res.writeHead(404);
        res.end();
        return;
    }
    res.writeHead(200, { "Content-Type": img.contentType, "Cache-Control": "no-store" });
    res.end(img.buffer);
});
imageServer.on("error", (err) => {
    // Doubles as a single-instance check: a second copy would otherwise fight the
    // first one over the Discord presence.
    console.error("Image server could not listen on port " + IMAGE_PORT + " (already running?):", err.message);
    process.exit(1);
});
imageServer.listen(IMAGE_PORT, "127.0.0.1");

function startTunnel() {
    const local = path.join(__dirname, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
    const bin = fs.existsSync(local) ? local : "cloudflared";
    const cloudflared = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${IMAGE_PORT}`]);
    const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
    let spawnFailed = false;

    const onOutput = (data) => {
        const match = data.toString().match(urlRegex);
        if (match && !tunnelUrl) {
            tunnelUrl = match[0];
            console.log("Cover art tunnel ready:", tunnelUrl);
            pushPresence();
        }
    };
    cloudflared.stdout.on("data", onOutput);
    cloudflared.stderr.on("data", onOutput);

    cloudflared.on("error", (err) => {
        spawnFailed = true;
        console.error("cloudflared failed to start (cover art will be unavailable):", err.message);
    });
    cloudflared.on("exit", (code) => {
        tunnelUrl = null;
        // Whether 'exit' fires after a failed spawn is unspecified by Node and varies
        // by platform, so spawnFailed makes the no-retry decision explicit.
        if (spawnFailed) return;
        console.error("cloudflared exited (code " + code + "), restarting in 3s...");
        setTimeout(startTunnel, 3000);
    });
}

async function loadArt(track) {
    const candidates = artCandidates(track);
    if (!candidates.length) return null;
    const key = crypto.createHash("md5").update(candidates[0]).digest("hex").slice(0, 12);
    if (images.has(key)) return images.get(key) ? key : null;

    let value = null;
    for (const url of candidates) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (!res.ok) continue;
            value = {
                buffer: Buffer.from(await res.arrayBuffer()),
                contentType: res.headers.get("content-type") || "image/jpeg",
            };
            break;
        } catch (err) {
            console.error("Cover art fetch failed:", err.message);
        }
    }
    if (!value) console.error("No cover art found for:", track.title);
    // A failure is cached as deliberately as a success: an unrecorded failure means
    // every poll restarts the same doomed fetch.
    images.set(key, value);
    if (images.size > IMAGE_CACHE_MAX) images.delete(images.keys().next().value);
    return value ? key : null;
}

// --- UPnP renderer ---

let controlUrl = null;

// LinkPlay-based renderers serve their description on a dynamic port that moves after
// a reboot, so the control URL is discovered rather than configured, and rediscovered
// whenever a request to it fails.
function ssdpSearch() {
    return new Promise((resolve) => {
        const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
        const locations = new Set();
        const msg = Buffer.from(
            "M-SEARCH * HTTP/1.1\r\n" +
            "HOST: 239.255.255.250:1900\r\n" +
            'MAN: "ssdp:discover"\r\n' +
            "MX: 2\r\n" +
            "ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n"
        );
        sock.on("error", () => {});
        sock.on("message", (buf) => {
            const m = /LOCATION:\s*(\S+)/i.exec(buf.toString());
            if (m) locations.add(m[1]);
        });
        sock.bind(() => {
            sock.send(msg, 1900, "239.255.255.250");
            setTimeout(() => {
                sock.close();
                resolve([...locations]);
            }, 3000);
        });
    });
}

// The friendly name lives in the description document, not in the SSDP reply, so every
// answer has to be fetched before any of them can be matched against rendererName.
async function describeRenderers() {
    const renderers = [];
    for (const location of await ssdpSearch()) {
        let xml;
        try {
            const res = await fetch(location, { signal: AbortSignal.timeout(5000) });
            xml = await res.text();
        } catch {
            continue;
        }
        const renderer = parseDescription(xml, location);
        if (renderer) renderers.push(renderer);
    }
    return renderers;
}

async function listRenderers() {
    const renderers = await describeRenderers();
    if (!renderers.length) {
        console.log("No UPnP renderer answered. Is the streamer powered up and on this network?");
        return;
    }
    console.log("Renderers on this network. Put a name in config.json as rendererName -");
    console.log("matching is case-insensitive on any part of it, so a distinctive word is enough.\n");
    for (const r of renderers) console.log("  " + r.name + "\n      " + r.control + "\n");
}

async function discover() {
    const renderer = matchRenderer(await describeRenderers(), config.rendererName);
    if (!renderer) return null;
    console.log("Renderer found:", renderer.name, "-", renderer.control);
    return renderer.control;
}

function soap(action) {
    const body =
        '<?xml version="1.0"?>' +
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
        `<u:${action} xmlns:u="${SERVICE}"><InstanceID>0</InstanceID></u:${action}>` +
        "</s:Body></s:Envelope>";
    return fetch(controlUrl, {
        method: "POST",
        headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPAction: `"${SERVICE}#${action}"` },
        body,
        signal: AbortSignal.timeout(5000),
    }).then((res) => {
        if (!res.ok) throw new Error(action + " returned HTTP " + res.status);
        return res.text();
    });
}

// --- Presence ---

let track = null; // what is on screen right now
let artKey = null;

async function poll() {
    try {
        if (!controlUrl) {
            controlUrl = await discover();
            if (!controlUrl) {
                console.error("No renderer matching '" + (config.rendererName || "*") + "' on the network.");
                return;
            }
        }

        const state = tag(await soap("GetTransportInfo"), "CurrentTransportState");
        if (state !== "PLAYING" && state !== "TRANSITIONING") {
            if (track) {
                console.log("Renderer is " + state + ", clearing presence.");
                track = null;
                artKey = null;
                pushPresence();
            }
            return;
        }

        const next = parseTrack(await soap("GetPositionInfo"));
        if (!next) return;

        // A poll every few seconds would otherwise redraw the presence constantly for
        // no visible gain, since Discord ticks the progress bar client-side from the
        // timestamps. Only a new track or a real seek needs a new payload - and a seek
        // does, or the bar keeps counting from the old position. Playback drift across
        // one interval stays well under the threshold; dragging the timeline does not.
        const drift = presenceDrift(track, next, Date.now());
        if (drift < SEEK_TOLERANCE) return;
        if (Number.isFinite(drift)) console.log("Seek detected, drift " + Math.round(drift) + "s");

        next.at = Date.now();
        track = next;
        artKey = await loadArt(next);
        pushPresence();
    } catch (err) {
        console.error("Renderer poll failed:", err.message);
        controlUrl = null;
    }
}

function pushPresence() {
    // rpc.user comes from the READY dispatch and is normally always present for a
    // local IPC login, but the library sets it conditionally - and rpc.user.setActivity
    // would throw synchronously, before .catch can attach, and crash the process.
    if (!discordReady || !rpc.user) return;

    if (!track) {
        rpc.user.clearActivity().catch(() => {});
        return;
    }

    const hasArt = Boolean(tunnelUrl && artKey);
    console.log("Presence update:", track.title, "| art=" + (hasArt ? artKey : "none"));

    const start = track.at - track.position * 1000;
    // type: Listening is what makes Discord render the Spotify-style progress bar
    // instead of plain "Playing" text.
    rpc.user
        .setActivity({
            type: ActivityType.Listening,
            details: formatLine(track.title),
            state: formatLine(track.artist),
            startTimestamp: start,
            endTimestamp: track.duration ? start + track.duration * 1000 : undefined,
            largeImageKey: hasArt ? `${tunnelUrl}/?k=${artKey}` : undefined,
            largeImageText: formatLine(track.album),
            instance: false,
        })
        .catch((err) => console.error("Failed to set Discord activity:", err.message));
}

connectDiscord();
startTunnel();
poll();
setInterval(poll, POLL_MS);
