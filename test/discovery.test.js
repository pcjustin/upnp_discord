"use strict";

// Real device description, trimmed to the parts discovery reads. A renderer publishes
// several services and the one that matters is not first, and its control URL is
// relative to wherever the document was fetched from.

const test = require("node:test");
const assert = require("node:assert");
const { parseDescription, matchRenderer } = require("../index.js");

const LOCATION = "http://10.0.0.20:49152/description.xml";
const DESCRIPTION = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
<device>
<friendlyName>Living Room Streamer  A1B2</friendlyName>
<serviceList>
<service>
<serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
<controlURL>/upnp/control/renderconnmgr1</controlURL>
</service>
<service>
<serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
<controlURL>/upnp/control/rendertransport1</controlURL>
</service>
<service>
<serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
<controlURL>/upnp/control/rendercontrol1</controlURL>
</service>
</serviceList>
</device>
</root>`;

test("picks the AVTransport service and resolves its control URL", () => {
    assert.deepStrictEqual(parseDescription(DESCRIPTION, LOCATION), {
        name: "Living Room Streamer  A1B2",
        control: "http://10.0.0.20:49152/upnp/control/rendertransport1",
    });
});

test("an absolute control URL is left alone", () => {
    const xml = DESCRIPTION.replace(
        "<controlURL>/upnp/control/rendertransport1</controlURL>",
        "<controlURL>http://10.0.0.99:8080/ctl</controlURL>"
    );
    assert.strictEqual(parseDescription(xml, LOCATION).control, "http://10.0.0.99:8080/ctl");
});

test("a device without AVTransport is not a renderer", () => {
    const xml = DESCRIPTION.replace("AVTransport", "ContentDirectory");
    assert.strictEqual(parseDescription(xml, LOCATION), null);
});

const RENDERERS = [
    { name: "Living Room Streamer  A1B2", control: "http://10.0.0.20/a" },
    { name: "Study DAC", control: "http://10.0.0.21/b" },
];

test("rendererName matches any part of the friendly name", () => {
    // The serial number in the full name is exactly what an owner would not type out,
    // so a prefix has to work - but pasting the whole listed name must work too.
    for (const wanted of ["Living Room Streamer  A1B2", "Living Room", "living", "  Study  "]) {
        assert.ok(matchRenderer(RENDERERS, wanted), wanted + " should match");
    }
    assert.strictEqual(matchRenderer(RENDERERS, "study").name, "Study DAC");
});

test("an empty rendererName takes the first renderer that answered", () => {
    assert.strictEqual(matchRenderer(RENDERERS, "").name, "Living Room Streamer  A1B2");
    assert.strictEqual(matchRenderer(RENDERERS, undefined).name, "Living Room Streamer  A1B2");
});

test("a name that matches nothing is not silently substituted", () => {
    assert.strictEqual(matchRenderer(RENDERERS, "Kitchen"), null);
    assert.strictEqual(matchRenderer([], "anything"), null);
});
