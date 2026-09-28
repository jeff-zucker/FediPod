// Signing up through the page the way a person does since 1.28.0: the pod is
// made first, on the provider's own sign-up page (stood in for here by the
// scratch CSS's account API, called from Node), then the page sends the
// browser to the pod's login, and the identity screen that follows sets the
// account up on that session and boots the agent. No password ever reaches
// the page.
//
// Takes the harness's own `evaluate` and `sleep`, like idp-login.mjs.
import path from 'node:path';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';
import { logInAtIdp } from './idp-login.mjs';

// The scratch CSS listens on IPv4; Node would try ::1 first and fail.
dns.setDefaultResultOrder('ipv4first');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { createAccountWithPod, mintCredential, makeDpopSession } = await import(path.join(root, 'web/app/pod-auth.mjs'));
const { givePublicTypeIndex } = await import('./pod-fixture.mjs');

/** Make the pod on the scratch CSS, as the provider's page would. */
export async function makePod({ issuer, email, password, podName }) {
  const made = await createAccountWithPod({ issuer, email, password, podName });
  // A real pod names a public type index from its profile; the scratch one
  // is given its own, with a credential minted for that alone.
  const cred = await mintCredential({ issuer, email, password, webId: made.webId, podUrl: made.pod, accountToken: made.accountToken, name: 'fedipod-fixture' });
  const dpop = await makeDpopSession(cred);
  await givePublicTypeIndex((u, i) => dpop.fetch(u, i), { pod: made.pod, webId: made.webId });
  return made;
}

/**
 * Drive the page from "create an account" to a booted agent. Returns what
 * `fedipodSignup` returned (undefined on success) or throws with the page's
 * error. The caller navigates to the app first and waits for boot.js.
 */
export async function signUpThroughPage(evaluate, sleep, { issuer, appOrigin, handle, email, password, shape = null }) {
  await makePod({ issuer, email, password, podName: handle });
  // Off to the pod's login: this navigates the tab, so the call itself may
  // not answer.
  await evaluate(`window.fedipodPodLogin({ issuer: ${JSON.stringify(issuer)} })`).catch(() => null);
  await logInAtIdp(evaluate, sleep, { email, password, appOrigin });
  // Back on the app with a session and no account: the identity screen. A
  // harness page that is only boot.js has no screen to show; there the sign
  // that the login has been completed is the `?code` gone from the address,
  // which boot.js strips right after the token exchange.
  let shown = false;
  for (let i = 0; i < 60 && !shown; i++) {
    shown = await evaluate(`typeof window.fedipodSignup === "function" && (document.getElementById("pane-form")
      ? !document.getElementById("pane-form").hidden
      : !new URLSearchParams(location.search).get("code"))`);
    if (!shown) await sleep(250);
  }
  if (!shown) {
    const why = await evaluate(`JSON.stringify({ href: location.href, visible: [...document.querySelectorAll('section, header, p#loading')].filter((e) => !e.hidden).map((e) => e.id), title: (document.getElementById('running-title') || {}).textContent, err: (document.getElementById('run-error') || {}).textContent })`);
    throw new Error('the identity screen never appeared after the pod login: ' + why);
  }
  const made = await evaluate(`window.fedipodSignup({ handle: ${JSON.stringify(handle)}${shape ? `, shape: ${JSON.stringify(shape)}` : ''} })`);
  if (made?.__error) throw new Error('signup: ' + made.__error);
  return made;
}
