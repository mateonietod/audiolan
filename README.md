# audiolan

Voice chat for everyone on your home network. Open a page on any phone, tablet or computer, enter a name, and talk. It works like a walkie-talkie or an always-on intercom between rooms.

- **Nothing leaves your network.** There is no cloud service, no account, and no outside server. A small server on one of your computers introduces the devices to each other.
- **Near-zero delay.** Audio goes straight from browser to browser over your Wi-Fi. It never passes through the server.
- **No app to install.** Any modern browser works. Phones can add it to the home screen.
- **Open mic or push-to-talk**, mute, device pickers, and a glow on whoever is speaking.

```text
  phone ─┐                      ┌─ laptop
         │   audio, direct      │
         ├──────────────────────┤
         │                      │
         └──── audiolan server ─┘   (introductions only)
               on one computer
```

## What you need

- **One computer that stays on** while people talk: macOS, Linux, Windows or a Raspberry Pi. It runs the server. Phones and tablets cannot run it; they only open the page.
- **[Node.js](https://nodejs.org) 26** on that computer. Version 22.12 or newer also works. npm comes with it.
- **[Git](https://git-scm.com)** to download the project. You can also use **Code → Download ZIP** on GitHub.
- **Every device on the same Wi-Fi or wired network.** Guest networks and "client isolation" keep devices apart, and audiolan cannot get through them.
- **A current browser** with a microphone: Chrome, Edge, Firefox or Safari.
- **openssl** (optional), used to make a certificate your devices can trust. macOS and most Linux distributions already have it. Without it, audiolan still works; browsers just show a warning every time.

To check what you have:

```bash
node --version    # v26.x (or v22.12 or newer)
git --version
```

## Quick start

1. **Download and install**

   ```bash
   git clone https://github.com/mateonietod/audiolan.git
   cd audiolan
   npm install
   ```

   With [nvm](https://github.com/nvm-sh/nvm), `nvm install` picks the right Node version from `.nvmrc`.

2. **Start the server**

   ```bash
   npm start
   ```

   Leave the terminal open. It prints the addresses to open, for example:

   ```text
     open
       https://audiolan.local:8787
       https://192.168.1.20:8787
       https://localhost:8787
   ```

   The first time, your system may ask for permissions. On macOS, allow Node to accept incoming connections and to find devices on the local network. On Windows, allow Node on **private** networks.

3. **Open it on this computer**

   Go to `https://localhost:8787`. The browser warns about the certificate the first time. Continue anyway (Chrome and Edge: **Advanced → Proceed**; Firefox: **Advanced → Accept the Risk**; Safari: **Show Details → visit this website**). To get rid of the warning for good, see [Remove the certificate warning](#remove-the-certificate-warning).

4. **Join**

   Enter a name and choose **Open the room**. Allow the microphone when the browser asks.

5. **Bring in everyone else**

   On each phone, tablet or other computer, open `https://audiolan.local:8787` and enter a name. If that name does not load (some routers and many Android phones do not resolve `.local` names), use the numbered address the server printed instead, such as `https://192.168.1.20:8787`.

That's it. To stop the server, press `Ctrl+C` in its terminal.

## Remove the certificate warning

Browsers only allow the microphone on secure (`https://`) pages, so audiolan makes its own certificate. Unless your devices trust it, they warn about it. Trusting it once per device also protects you: a device that trusts it refuses an impostor on the network, while a device that has learned to click through warnings does not.

**If [mkcert](https://github.com/FiloSottile/mkcert) is installed**, audiolan uses it. Run `mkcert -install` once on the server computer. For phones, install mkcert's root certificate (its location is shown by `mkcert -CAROOT`).

**Otherwise**, audiolan creates a **household certificate authority (CA)** the first time it starts, using openssl. It can only vouch for local names (`*.local`, `localhost`) and private addresses, so trusting it does not let this computer impersonate any website. At startup the server prints its fingerprint:

```text
  on each phone, open https://audiolan.local:8787/ca.crt once and trust it.
  check that its SHA-256 matches  DF:45:6E:...
```

On each device:

1. Open `https://audiolan.local:8787/ca.crt`, or the numbered address followed by `/ca.crt`. Continue past the warning this one time.
2. Compare the SHA-256 fingerprint the device shows with the one in the server's terminal. **If they differ, stop**: something else answered on your network.
3. Trust it:
   - **iPhone and iPad:** Settings → *Profile Downloaded* → Install. Then Settings → General → About → Certificate Trust Settings → turn on the audiolan CA.
   - **Android:** Settings → Security → Encryption & credentials → Install a certificate → CA certificate → choose the downloaded file. (The menu names vary a little by phone.)
   - **macOS:** double-click the downloaded file, then in Keychain Access open it and set **Trust → When using this certificate** to **Always Trust**.
   - **Windows:** double-click the file → Install Certificate → Local Machine → *Place all certificates in the following store* → **Trusted Root Certification Authorities**.
   - **Linux:** Chrome and Firefox keep their own lists. Import it under Settings → Privacy and security → Certificates (Authorities tab).
4. Reload the audiolan page. The warning is gone.

The CA lives in `.certs/` and is reused whenever the router gives the computer a new address. If you delete `.certs/`, a new CA is made and every device has to trust it again.

## Install it like an app

Once a device trusts the certificate, the page can be installed. This also works as is on the server computer itself, at `https://localhost:8787`.

- **iPhone and iPad (Safari):** Share → Add to Home Screen.
- **Android (Chrome):** ⋮ menu → Install app (or Add to Home screen).
- **Desktop Chrome and Edge:** the install icon at the right of the address bar.

During a call the screen stays awake, and phones show the call in their system controls where supported.

## Run it on an always-on computer

The server has to be running for anyone to talk. Running it on a computer that never sleeps, such as a Raspberry Pi, a NAS or a small home server, is the easiest setup.

### With Docker (Linux)

You need [Docker](https://docs.docker.com/engine/install/) with the Compose plugin. In the project folder:

```bash
docker compose up -d             # build and start, and restart it after reboots
docker compose logs audiolan     # see the addresses and the CA fingerprint
```

To stop it: `docker compose down`. To update it: `git pull` then `docker compose up -d --build`.

`compose.yaml` uses **host networking**, which audiolan needs. It finds other servers with multicast on your LAN, names the computer's LAN addresses in its certificate, and only lets in devices on your network. Inside Docker's default bridge network it would see a container address instead. Docker Desktop on macOS and Windows does not support this, so on those systems use `npm start`.

Certificates, including the household CA, are kept on the `certs` volume, so updating the image does not make devices trust a new one. Settings go in the `environment:` section of `compose.yaml`.

To build an image for a Raspberry Pi from another computer: `docker buildx build --platform linux/arm64 -t audiolan .`

### Without Docker

Any way of keeping `npm start` running works: a terminal you leave open, or a service manager such as systemd (Linux), launchd (macOS) or [pm2](https://pm2.keymetrics.io) (any system).

## Several computers

You can run audiolan on more than one computer, for example so each laptop has it open. They find each other automatically and form one room. The computer that has been running longest hosts it. If it stops, the next one takes over, and calls carry on.

Every computer must run the same version. A computer on an older version is told to update instead of joining.

## Using it

- The join screen shows whether a call is on and who is in it ("Bob and Alice", or "Bob, Alice and more" past two people). It updates every few seconds.
- **Test microphone** on the join screen shows a level meter and unlocks the device lists.
- **Mute** (or press `M`) cuts your microphone.
- The **⋯** button during a call picks the microphone and speaker. The browser remembers your choice.
- **Open** sends audio whenever you are unmuted.
- **Hold** is push-to-talk. Hold Space, or hold the Talk button. **Change key** lets you pick another key or a side mouse button. On a phone, use the large **Hold to talk** button.
- A person's circle glows while they speak. **Retry** appears under someone who cannot be reached.
- **Another address** on the join screen opens a different audiolan server by address.

## Settings

audiolan works without any settings. To change something, set an environment variable when you start it.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8787` | Port the server listens on. |
| `AUDIOLAN_SECRET` | none | Recommended if other people share your network (an apartment building, a shared house). Set the same value, at least 16 characters, on every computer that runs audiolan. Only servers that know it can host your room. Make one with `openssl rand -base64 18`. |
| `AUDIOLAN_ALLOW` | none | Extra networks allowed to connect, as IPv4 ranges: `10.0.0.0/8,100.64.0.0/10`. Use it for a second subnet or Tailscale. `any` turns the network check off. |
| `AUDIOLAN_DISCOVERY` | on | `off` stops looking for other servers. This computer then always hosts its own room. |
| `AUDIOLAN_CERTS` | `.certs/` | Folder for the certificates and the household CA. The Docker image uses `/data/certs`. |
| `AUDIOLAN_DEBUG` | off | `1` logs the discovery records this server hears. |

Setting a variable:

```bash
# macOS and Linux
AUDIOLAN_SECRET="your-secret-here" npm start

# Windows (PowerShell)
$env:AUDIOLAN_SECRET="your-secret-here"; npm start
```

With Docker, put them under `environment:` in `compose.yaml`.

## Updating

```bash
git pull
npm install
```

Then restart the server. Update every computer that runs audiolan; they must all be on the same version.

## Troubleshooting

**The page does not load on my phone.**
- Make sure the phone is on the same Wi-Fi as the server, not a guest network.
- Try the numbered address (`https://192.168.x.x:8787`) instead of `audiolan.local`.
- Check that the server is still running, and that the computer's firewall allows Node on private networks.
- If the server's terminal says `refused ... not on this network`, the device is on another subnet or a VPN. Add its network with `AUDIOLAN_ALLOW`.

**People join but nobody hears anything.**
- Guest Wi-Fi, client isolation and VPNs block the direct audio path between devices. Turn off the VPN, or use the main network.
- Check that the browser has the microphone. If you denied it, click the lock icon in the address bar and set Microphone back to Ask or Allow.
- Check that the right microphone and speaker are selected under **⋯**.

**There is a loud howl.** Two open microphones in the same physical room feed back into each other. Use **Hold** (push-to-talk), mute one of them, or use headphones.

**`Port 8787 is already in use`.** Another copy of audiolan (or another program) is running. Stop it, or start with a different port: `PORT=8800 npm start`.

**"Another computer runs a different version".** Update audiolan on every computer and restart them.

**The browser keeps warning about the certificate.** Trust the household CA on that device; see [Remove the certificate warning](#remove-the-certificate-warning).

**Measuring the delay.** Add `#debug` to the page address (`https://audiolan.local:8787/#debug`). Each person then shows the round trip, the receive buffer, packet loss and the connection path. At home the path should read `host/udp`.

## Privacy and security

- The server only introduces devices. Audio flows directly between browsers and is encrypted (WebRTC always encrypts media).
- Nothing contacts the internet. The page loads its fonts and code from your server, there is no analytics, and no outside STUN or relay server is used.
- Only this computer and devices on its own network can connect. Connections from VPNs, containers or the internet are dropped.
- Anyone on your network can open the page and join. Being on the Wi-Fi is the invitation, so keep your Wi-Fi password private. The join screen also shows them up to two names of the people already on the call.
- On a network you share with others, set `AUDIOLAN_SECRET` so that no other device can take over hosting your room, and trust the household CA on your devices so that an impostor is refused.

## How it works

- Each server announces itself on the network over mDNS. On macOS that goes through the system's mDNS responder (`dns-sd`), because a normal socket cannot share port 5353. Elsewhere it is plain multicast. The server that has been up longest hosts the room. The others relay their browsers' signaling to it, pinning its certificate. When the host stops, the next oldest takes over. When an older one appears, people move to it once a connection to it succeeds.
- A host is only ever an address on this network. With `AUDIOLAN_SECRET`, announcements are signed, and only servers with the same secret take part.
- A dropped signaling connection (a Wi-Fi blip, a laptop lid) reconnects and resumes the same session for up to 12 seconds. The audio links stay up the whole time.
- Audio links that fail are rebuilt automatically by the side with the smaller id, so the two sides never fight over it.
- Voice is sent in 10 ms Opus frames, half the browser default, to cut delay.

## Develop

```bash
npm test          # unit tests (node:test)
npm run check     # type-check all JavaScript with TypeScript (JSDoc types)
npm run icons     # redraw public/icons after changing the design
```

```text
server.js              wiring: HTTPS, WebSocket, election
lib/room.js            signaling for one room, with session resume
lib/discovery.js       mDNS publish and browse, the election
lib/bridge.js          relay to the room host on another computer
lib/keepalive.js       pings sockets and drops the ones that stopped answering
lib/http.js            static files and security headers
lib/certs.js           mkcert, then a household CA with openssl, then a pure-JS certificate
lib/network.js         LAN interfaces, subnets, and who may connect
public/                the page, fonts, manifest, service worker, icons
public/js/protocol.js  what the page and the server share: protocol version, name cleaning
public/fonts/          Geist and Geist Serif (SIL Open Font License), from the geist npm package
test/                  unit tests
Dockerfile             the image; compose.yaml runs it with host networking
```

Add `#debug` to the page address to log negotiation in the browser console.

## License

[MIT](LICENSE). The bundled Geist fonts are under the SIL Open Font License (`public/fonts/OFL.txt`).
