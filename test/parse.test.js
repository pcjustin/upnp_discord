"use strict";

// Real GetPositionInfo response from the renderer, playing a MinimServer track.
// It is the only input the presence is built from, so parsing it is what gets tested.

const test = require("node:test");
const assert = require("node:assert");
const { parseTrack, hms, decode, formatLine, artFromSearchResult } = require("../index.js");

const SAMPLE = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<u:GetPositionInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
<Track>0</Track>
<TrackDuration>00:01:47</TrackDuration>
<TrackMetaData>&lt;?xml version=&quot;1.0&quot;?&gt;
&lt;DIDL-Lite xmlns=&quot;urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/&quot;&gt;
&lt;item id=&quot;0$:albums$*a375&quot; parentID=&quot;0&quot; restricted=&quot;1&quot;&gt;
&lt;upnp:class&gt;object.item.audioItem.musicTrack&lt;/upnp:class&gt;
&lt;dc:title&gt;Flight to LAPD&lt;/dc:title&gt;
&lt;dc:creator&gt;Benjamin Wallfisch, Hans Zimmer&lt;/dc:creator&gt;
&lt;upnp:artist&gt;Benjamin Wallfisch &amp;amp; Hans Zimmer&lt;/upnp:artist&gt;
&lt;upnp:albumArtURI&gt;http://10.0.0.30:9790/minimserver/*/Music/x.flac/$!pict&lt;/upnp:albumArtURI&gt;
&lt;upnp:album&gt;Blade Runner 2049 (Original Motion Picture Soundtrack)&lt;/upnp:album&gt;
&lt;/item&gt;
&lt;/DIDL-Lite&gt;
</TrackMetaData>
<TrackURI>http://10.0.0.30:9790/minimserver/*/Music/x.flac</TrackURI>
<RelTime>00:00:18</RelTime>
<AbsTime>NOT_IMPLEMENTED</AbsTime>
</u:GetPositionInfoResponse>
</s:Body></s:Envelope>`;

test("parses a playing track out of GetPositionInfo", () => {
    const t = parseTrack(SAMPLE);
    assert.strictEqual(t.title, "Flight to LAPD");
    // The ampersand survives both encoding layers as a single "&".
    assert.strictEqual(t.artist, "Benjamin Wallfisch & Hans Zimmer");
    assert.strictEqual(t.album, "Blade Runner 2049 (Original Motion Picture Soundtrack)");
    assert.strictEqual(t.art, "http://10.0.0.30:9790/minimserver/*/Music/x.flac/$!pict");
    assert.strictEqual(t.duration, 107);
    assert.strictEqual(t.position, 18);
    assert.strictEqual(t.id, "http://10.0.0.30:9790/minimserver/*/Music/x.flac");
});

test("an idle renderer yields no track", () => {
    assert.strictEqual(parseTrack("<TrackMetaData>NOT_IMPLEMENTED</TrackMetaData>"), null);
});

test("hms handles clock strings and junk", () => {
    assert.strictEqual(hms("01:02:03"), 3723);
    assert.strictEqual(hms("NOT_IMPLEMENTED"), 0);
    assert.strictEqual(hms(undefined), 0);
});

test("decode does not invent markup from escaped entities", () => {
    assert.strictEqual(decode("&amp;lt;b&amp;gt;"), "&lt;b&gt;");
});

test("formatLine keeps Discord's length limits", () => {
    assert.strictEqual(formatLine("愛"), "愛 ");
    assert.strictEqual(formatLine("x".repeat(200)).length, 128);
    assert.strictEqual(formatLine(undefined), undefined);
});

// The renderer cut this track's upnp:albumArtURI off at 256 characters; the media
// server's own answer to a Search for the same res is where the whole URL comes back.
const SEARCH_RESULT = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<u:SearchResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
<Result>&lt;DIDL-Lite&gt;&lt;item id=&quot;0$1&quot;&gt;&lt;upnp:albumArtURI dlna:profileID=&quot;JPEG_LRG&quot;&gt;http://10.0.0.30:9790/minimserver/*/Music/a&amp;amp;b.flac/$!picture-686-944282.jpg&lt;/upnp:albumArtURI&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;</Result>
<NumberReturned>1</NumberReturned>
</u:SearchResponse>
</s:Body></s:Envelope>`;

test("the media server's full art URL survives both entity layers", () => {
    assert.strictEqual(
        artFromSearchResult(SEARCH_RESULT),
        "http://10.0.0.30:9790/minimserver/*/Music/a&b.flac/$!picture-686-944282.jpg"
    );
});

test("a search that matched nothing yields no art", () => {
    assert.strictEqual(artFromSearchResult("<Result></Result><NumberReturned>0</NumberReturned>"), null);
});
