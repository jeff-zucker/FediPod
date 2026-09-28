// Signing in at a real CSS, in headless Chrome, the way a person does.
//
// Sign-up hands the browser to the pod's own login (boot.mjs redirects to the
// authorize URL) and the agent boots on the Solid-OIDC session that comes back.
// So a test that stops at sign-up has not signed in — it has to fill the login
// form and agree to the consent screen, both of which are ordinary pages.
//
// Used by sw-run and full-run. Takes the harness's own `evaluate` and `sleep`,
// so it needs no CDP plumbing of its own. `IDP_DEBUG=1` prints the URL and title
// at each step, which is the only way to see where a login stalls.
export async function logInAtIdp(evaluate, sleep, { email, password, appOrigin, tries = 40 }) {
  const trace = (...a) => process.env.IDP_DEBUG && console.log('  [idp]', ...a);
  for (let i = 0; i < tries; i++) {
    const url = await evaluate('location.href');
    trace(i, url, await evaluate('document.title'));
    if (typeof url === 'string' && url.startsWith(appOrigin)) return url;   // back on the app

    // The login form: email, password, submit. `.click()` rather than
    // `.submit()`, because CSS's page wires its handler to the button.
    const filled = await evaluate(`(() => {
      const f = document.querySelector('form');
      if (!f || !f.elements.email || !f.elements.password) return false;
      f.elements.email.value = ${JSON.stringify(email)};
      f.elements.password.value = ${JSON.stringify(password)};
      (f.querySelector('button[type=submit], input[type=submit]') || f).click?.();
      return true;
    })()`);
    if (filled === true) { await sleep(1500); continue; }

    // The consent screen: one button, and its label is the only thing marking
    // it out from the "no thanks" beside it.
    const consented = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button, input[type=submit], a')]
        .find(e => /authorize|consent|allow|continue|agree/i.test(e.textContent || e.value || ''));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (consented === true) { await sleep(1500); continue; }

    await sleep(500);
  }
  throw new Error(`never got back to ${appOrigin} — stuck at ${await evaluate('location.href')}`);
}
