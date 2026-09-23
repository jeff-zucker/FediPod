# Sengi is patched

`sengi/dist/` is **not** a stock Sengi build. It is Sengi 1.9.1 with ten
changes of ours, listed below. Phanpy at `/app/` is vendored untouched; Sengi is
not, and **every upgrade means re-applying these**, or the client breaks in ways
that are not obvious from the outside (two of them fail silently).

Upstream: <https://github.com/NicolasConstant/sengi>, MIT.

## Building it

Sengi is Angular 7 and will not build on a current Node. Under nvm:

```bash
nvm use 12.22.6 && npm ci && npm run build
```

Then trim and vendor — the emoji pictures come from the CDN (change 10), and
this origin already has a service worker of its own:

```bash
rm -rf sengi/dist && cp -a <build>/dist sengi/dist
rm -rf sengi/dist/assets/emoji
rm -f sengi/dist/ngsw.json sengi/dist/ngsw-worker.js sengi/dist/safety-worker.js sengi/dist/worker-basic.min.js
```

`node claude/validation/browser-agent/sengi-run.mjs` drives the built client
against a real agent in headless Chrome and covers every one of these.

## The changes

**1. It assumed it was served at the site root.**
`components/floating-column/add-new-account/add-new-account.component.ts`,
`getLocalHostname()`. It built its OAuth redirect from `location.hostname`, so
the code came back to `/` — FediPod's sign-in page — and was lost. Now uses
`document.baseURI`, which is where the app actually is.

**2. Its own service worker, twice.** `app.module.ts` (`ServiceWorkerModule
.register`) and again in `main.ts` after bootstrap. This origin already has a
service worker — the BrowserAgent itself, at scope `/` — and Sengi's is only a
caching layer a standalone deployment wants. Both are off. Turning off only the
first one is not enough; the `main.ts` call is separate.

**3. Errors vanished after five seconds.**
`components/notification-hub/notification-hub.component.ts`. Every notification
cleared on a timer, errors included, so the one account of what went wrong was
gone before it could be read. Errors now stay until clicked and also go to the
console; anything else still clears itself.

**4. It signs itself in.** `app.component.ts` opens the add-account panel when
there is no account, and `add-new-account.component.ts` fills it with the host
the page was served from and submits. Phanpy is signed in the same way by the
shell around it, over its own `#/login?instance=…&submit=1`; Sengi has no such
address, so it does the equivalent itself. Two limits are deliberate: the
instance comes from where the page is served and never from anything a link
could carry, and it only fires with no account at all — a second account is the
ordinary "+" and anybody's instance.

**5. …and not while one is arriving.** Same two files. The OAuth code comes back
to this same address, and the account does not exist until it has been
exchanged, so "no account yet" is still true on the way back — acting on it
started a second sign-in over the top of the first and replaced what the first
had stored. Sengi then said *"Something went wrong in the authentication
process"*. Both places now stand down when the address carries a `code`.

**6. A stored login that has stopped working.** `app.component.ts`. The agent
keeps only its most recent tokens, so an older one is no longer recognised and
every call answers *"The access token is invalid"* — which Sengi showed, over
and over, with no way out but knowing to remove the account by hand. It now
checks the stored login against the agent before trusting it, drops a dead one
and signs in again. Only this host's accounts are touched: somebody else's
server is not ours to test and not ours to drop. Phanpy's shell has done this
since it was written (`web/admin/client/client.js`).

**7. It lands on a timeline.** `app.component.ts`. Sengi's answer to an account
with no columns is a screen telling you to right-click your avatar and choose
one — reasonable for somebody who came looking for Sengi, poor for somebody who
just opened their own account. Such an account now gets a Home column. Checked
on every visit and not only when an account is added, because an account that
was already stored never goes through the add path again and would never have
got one. Only when there are no columns at all, so a second account never
pushes one into an arrangement the owner has made.

**8. …without the tour over the top of it.** Same file. Sengi's first-run tour
opens above the column and has to be dismissed before anything can be read. It
is marked as already seen at the same moment, using the flag the tour's own
Close button sets.

**9. Columns are 420px, not 320px.** `sass/_variables.scss`,
`$stream-column-width`. It is a build-time constant with no setting behind it,
so the only way to have wider columns is to build them wider. Two places did
not use that variable and restated `320px` instead — `.stream-statuses` in
`stream.component.scss` and `$inner-column-size` in `hashtag.component.scss` —
so a wider column was wider whitespace with the posts still 320px inside it.
Both follow the variable now.

**10. Emoji pictures come from the CDN.** `services/emoji.service.ts` (the
converter's `applyEmojis`) and the composer's emoji button in
`status-editor.component.html`. Sengi's emoji are JoyPixels, which the
jsdelivr CDN serves; Sengi rewrote that CDN address to its own
`assets/emoji/` folder and shipped 3,828 pictures, 20 MB, in every build.
The rewrite is gone and the button names the CDN picture directly, so the
folder is not vendored at all: the deploy tree went from 4,144 files to
about 300. A reader whose browser cannot reach jsdelivr sees text emoji.
In the built bundle the two spots are the
`for(;t.includes("https://cdn.jsdelivr.net/joypixels/…");)` loop, removed,
and `["src","/assets/emoji/64/1f636.png"]`, now the CDN URL.
