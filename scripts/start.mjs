// start.mjs — what `npm start` says in this repository. Nothing starts here:
// FediPod runs in a browser at a Gateway, and a Gateway is deployed, not
// started. Until 2026-09-28 `npm start` started the DeviceAgent, which is
// deprecated and opened a setup page asking for a pod password.
console.log(`FediPod is not started from this directory.

  In a browser:        open a Gateway such as https://fedipod.net and create an
                       account. Nothing is installed.
  A Gateway of your own:  deploy this repository to Netlify — netlify/README.md
  A pod server with FediPod built in:  https://github.com/jeff-zucker/fedipod-server
  A forum:             https://github.com/jeff-zucker/fedipod-bb, or "A forum" on a
                       Gateway's sign-up page
`);
