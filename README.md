# UPnP Discord Presence

Shows the track your UPnP streamer is playing as Discord Rich Presence, with cover art
and a progress bar.

It reads the streamer (the UPnP renderer) directly, so the control point is irrelevant —
JPLAY, BubbleUPnP, mconnect, a NAS web UI, the streamer's own front panel all look the
same from here. Nothing is installed on the controller or the NAS, and the presence keeps
working after the controlling app is closed.

Tested with JPLAY on an iPad driving a KECES Essential Bravo, pulling FLAC from
MinimServer on the NAS.

## How it works

1. Finds the renderer on the LAN by SSDP, matching `rendererName` in `config.json`
   against the device's friendly name (`--list` prints the names it can see).
2. Polls its `AVTransport` service every 5 seconds for transport state, track metadata
   and playback position.
3. Sends title, artist, album and elapsed/remaining time to Discord.

Cover art lives on the NAS at a LAN address the Discord client cannot reach, so the art
is cached locally and published through a `cloudflared` quick tunnel — that public URL is
what Discord is given. Without `cloudflared` everything still works, minus the artwork.

## Setup

1. Create an application at <https://discord.com/developers/applications>. Its
   **Application ID** goes into `config.json`, and its **Name** becomes the name Discord
   shows on the presence — see below.
2. Install dependencies, and `cloudflared` if you want cover art (see below):

   ```sh
   npm install
   ```
3. Ask the network which renderers are out there — friendly names differ per device,
   so read yours rather than guessing:

   ```sh
   node index.js --list
   ```

   ```
   Renderers on this network. Put a name in config.json as rendererName -
   matching is case-insensitive on any part of it, so a distinctive word is enough.

     Living Room Streamer
         http://10.0.0.20:49152/upnp/control/rendertransport1

     Study DAC
         http://10.0.0.21:1487/AVTransport/.../control.xml
   ```
4. Copy `config.example.json` to `config.json` and fill it in:

   ```json
   {
     "discordClientId": "123456789012345678",
     "rendererName": "Living Room"
   }
   ```

   `rendererName` is a case-insensitive substring of the friendly name, so a distinctive
   word is enough. Leave it empty, as the example file does, to take the first renderer
   that answers — which is all a one-streamer network needs.
5. Run it, with the Discord desktop app open on the same machine:

   ```sh
   node index.js
   ```

## Keeping it running (macOS)

`launchd` starts it at login and restarts it if it dies. Write
`~/Library/LaunchAgents/com.example.upnp-discord.plist`, with the two absolute paths
replaced by yours (`which node` and the checkout directory):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.example.upnp-discord</string>
    <key>ProgramArguments</key>
    <array>
        <string>/absolute/path/to/node</string>
        <string>/absolute/path/to/upnp_discord/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/absolute/path/to/upnp_discord</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>/Users/you/Library/Logs/upnp-discord.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/you/Library/Logs/upnp-discord.log</string>
</dict>
</plist>
```

`PATH` is not decoration: agents start with a minimal one that excludes Homebrew, so
without it `cloudflared` is never found and cover art quietly stops working.

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.upnp-discord.plist
launchctl print gui/$(id -u)/com.example.upnp-discord | grep -E 'state|pid'
tail -f ~/Library/Logs/upnp-discord.log

launchctl kickstart -k gui/$(id -u)/com.example.upnp-discord   # restart after an edit
launchctl bootout gui/$(id -u)/com.example.upnp-discord        # stop and unload
```

Point `ProgramArguments` at a real node binary, not a shim: a version manager's path
carries the version in it, so the agent stops starting after an upgrade and the only
sign is a presence that never appears.

## Installing cloudflared

Only cover art needs it — everything else works without it, and it needs no Cloudflare
account or domain, since quick tunnels are anonymous and disposable.

```sh
brew install cloudflared            # macOS
winget install --id Cloudflare.cloudflared   # Windows
```

Debian/Ubuntu and RPM packages, plus plain binaries for every platform, are at
<https://github.com/cloudflare/cloudflared/releases>.

Any binary named `cloudflared` (`cloudflared.exe` on Windows) placed next to `index.js`
is used in preference to one on the `PATH`, which is the easiest route on a machine
without a package manager.

## The name Discord shows

The "Listening to ..." line is the **Name** of the Discord application, taken from the
Developer Portal. It is not sent by this program and nothing in `config.json` affects it,
so changing it means renaming the application at
<https://discord.com/developers/applications>.

The rename takes effect on Discord's side at once — `https://discord.com/api/v10/applications/<id>/rpc`
returns the new name straight away — but the desktop client keeps serving the old one from
cache until it is fully quit (⌘Q on macOS, closing the window is not enough) and reopened.

## Notes

- Presence updates lag playback by up to 5 seconds. Discord ticks the progress bar itself
  between polls, so the bar stays smooth; only track changes and seeks are pushed.
- The renderer's UPnP port moves after a reboot. Discovery is redone automatically
  whenever a request to it fails, so no config change is needed.
- MinimServer advertises the album's art as the first track's embedded picture, which
  404s when the art sits beside the files instead. `cover.jpg` / `folder.jpg` in the
  album folder are tried next.
- The renderer truncates every metadata field at 256 characters, so a deep path — and a
  CJK one is mostly percent escapes — loses the tail of the art URL and it 404s. When
  every candidate fails, the media server is asked for the track again by its full URI,
  which is where the whole art URL comes back from.
- Cover art can take a few seconds to appear after a restart. Discord fetches the URL
  through its own media proxy and caches it, and the quick tunnel hands out a fresh
  hostname on every run, so the first fetch of a run is always a cold one.
- Only one instance can run at a time — a second one exits rather than fight the first
  over the presence.

## Tests

```sh
npm test
```
