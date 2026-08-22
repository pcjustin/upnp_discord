"use strict";

// The two decisions that reach Discord: when to send an update at all, and which URL
// to try for the cover.

const test = require("node:test");
const assert = require("node:assert");
const { presenceDrift, artCandidates } = require("../index.js");

// A track as poll() holds it: `at` is when `position` was read.
const showing = { id: "http://10.0.0.30/a.flac", position: 30, at: 1_000_000 };

test("normal playback does not resend the presence", () => {
    // Five seconds later the renderer is five seconds further in, as expected.
    const drift = presenceDrift(showing, { id: showing.id, position: 35 }, 1_005_000);
    assert.strictEqual(drift, 0);
});

test("a poll that arrives late is still normal playback", () => {
    // Timers slip; a second of slack must not read as a seek.
    const drift = presenceDrift(showing, { id: showing.id, position: 35 }, 1_006_200);
    assert.ok(drift < 5, "drift was " + drift);
});

test("dragging the timeline forwards or backwards is a seek", () => {
    assert.ok(presenceDrift(showing, { id: showing.id, position: 90 }, 1_005_000) >= 5);
    assert.ok(presenceDrift(showing, { id: showing.id, position: 2 }, 1_005_000) >= 5);
});

test("a different track always needs a new payload", () => {
    // Infinity, not a large number: no tolerance should ever suppress a track change,
    // including one that happens to land at a similar position.
    assert.strictEqual(presenceDrift(showing, { id: "http://10.0.0.30/b.flac", position: 31 }, 1_005_000), Infinity);
    assert.strictEqual(presenceDrift(null, { id: showing.id, position: 0 }, 1_005_000), Infinity);
});

test("repeating the same track counts as a change", () => {
    // Same id, but the position went back to the start - which is a seek by any measure.
    assert.ok(presenceDrift(showing, { id: showing.id, position: 0 }, 1_005_000) >= 5);
});

test("the folder image is tried after the advertised art", () => {
    assert.deepStrictEqual(
        artCandidates({ id: "http://10.0.0.30/Album/03.flac", art: "http://10.0.0.30/Album/01.flac/$!pict" }),
        [
            "http://10.0.0.30/Album/01.flac/$!pict",
            "http://10.0.0.30/Album/cover.jpg",
            "http://10.0.0.30/Album/folder.jpg",
        ]
    );
});

test("a track with no advertised art still gets the folder image", () => {
    assert.deepStrictEqual(artCandidates({ id: "http://10.0.0.30/Album/03.flac" }), [
        "http://10.0.0.30/Album/cover.jpg",
        "http://10.0.0.30/Album/folder.jpg",
    ]);
});

test("a track identified by title yields no folder to guess from", () => {
    // id falls back to the title when the renderer reports no TrackURI, and a title is
    // not a path - trimming its last segment would produce a URL for something else.
    assert.deepStrictEqual(artCandidates({ id: "Flight to LAPD" }), []);
    assert.deepStrictEqual(artCandidates({ id: "Flight to LAPD", art: "http://10.0.0.30/x.jpg" }), [
        "http://10.0.0.30/x.jpg",
    ]);
});
