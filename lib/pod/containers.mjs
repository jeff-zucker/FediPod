// containers.mjs — making a container exist, and making its access right.
//
// A container on a Solid pod is not created; it is implied by something being
// in it. So every provisioning here writes one small canary document and then
// states the access rule the container is supposed to have. The two are one
// operation on purpose: a container that exists without its ACL is either
// world-readable when it should not be, or unreachable when it should not be,
// and both have happened by writing one and not the other.
//
// The probes at the bottom take a `probe` function rather than a transport,
// and that is the whole point of them: they ask what a STRANGER sees. Handing
// them a credential would answer a different question, and answer it wrongly.

const KEEP = { keep: true };
const KEEP_CT = 'application/json';

/** The canary this module writes, and reads back to ask whether it was here. */
const keepUrl = (base) => `${base}.keep`;

// ---- the owner's agent, holding the pod's own credential ----

/**
 * Whether this container has already been provisioned.
 *
 * Only a definite "yes" counts: anything else falls through to the write,
 * which is idempotent anyway, so a failed probe costs a request and never
 * correctness. Worth asking because the alternative is re-provisioning — and
 * rewriting an ACL — every time a service worker restarts, which is whenever
 * the browser feels like it.
 */
export async function exists(pod, base) {
  try {
    const r = await pod.fetch(keepUrl(base), { method: 'HEAD' });
    return r?.status >= 200 && r.status < 300;
  } catch { return false; }
}

/** Bring a container into being with an owner-only rule. */
export async function provisionOwnerOnly(pod, base) {
  await pod.putJson(keepUrl(base), KEEP, KEEP_CT);
  await pod.setAcl(base, []);
}

/** Bring a container into being, world-readable — a published tree. */
export async function provisionPublic(pod, base) {
  await pod.putJson(keepUrl(base), KEEP, KEEP_CT);
  await pod.setAcl(base, ['Read']);
}

/**
 * The private half: the home itself and the state container.
 *
 * Idempotent, so two devices doing it at once is harmless — which is what
 * makes it safe to run on every boot rather than only at setup.
 */
export async function provisionPrivate(pod, urls) {
  await pod.putJson(keepUrl(urls.state), KEEP, KEEP_CT);
  await pod.setAcl(urls.state, []);
  await pod.setAcl(urls.home, []);
}

/**
 * Check the private trees are actually private, and put back any that are not.
 *
 * An ACL write that silently failed — or that something else changed
 * afterwards — leaves the private trees, signing keys among them, readable by
 * anyone. Setup writes them once and never returns, so this is what makes it a
 * standing property rather than a one-time hope.
 *
 * Returns what it found rather than logging: what a finding MEANS, and how
 * loudly to say it, belongs to the application.
 *
 * `isPublic` is supplied rather than assumed: how you decide a tree is
 * world-readable — which headers, which timeout — is the caller's business.
 *
 * @returns {Promise<Array<{url, rewritten, stillPublic, error}>>} one entry per
 *          tree that was readable without credentials; empty when all is well.
 */
export async function repairPrivateAcls(pod, trees, { isPublic } = {}) {
  const findings = [];
  for (const url of trees) {
    if (!await isPublic(url)) continue;
    const finding = { url, rewritten: false, stillPublic: false, error: null };
    findings.push(finding);
    try {
      await pod.setAcl(url, []);
      finding.rewritten = true;
    } catch (e) {
      finding.error = e.message;
      continue;
    }
    finding.stillPublic = await isPublic(url);
  }
  return findings;
}

// ---- anyone at all: what a stranger can see ----

/**
 * Is this readable with no credentials?
 *
 * `accept: *\/*` matters. Asking for turtle makes a server answer 501 on the
 * JSON documents — webfinger, the actor — which reads as "unreachable" when
 * the world can in fact see them perfectly well.
 *
 * Unreachable is not a finding: a pod that failed to answer has not been shown
 * to be public, and treating that as one would rewrite ACLs on a network blip.
 */
export async function probePublicReadability(probe, url, { headers = {}, timeoutMs = 20_000 } = {}) {
  try {
    const res = await probe(url, {
      headers: { accept: '*/*', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status < 400;
  } catch { return false; }
}

/**
 * Does this pod actually ENFORCE an owner-only rule?
 *
 * A bare, unauthenticated read of the private container's canary must be
 * refused. Anything else — including a redirect to a login page, which is why
 * redirects are not followed — means documents meant to be private would not
 * be, and the caller should decline to put private things here.
 *
 * Takes a POD-SPACE url: an identity whose ids are advertised elsewhere must
 * map back to the pod first, because the rule being tested is the pod's.
 *
 * @returns {Promise<true|string>} true, or why not
 */
export async function probePrivateEnforcement(probe, podKeepUrl) {
  const r = await probe(podKeepUrl, { redirect: 'manual' });
  if (r.status === 401 || r.status === 403) return true;
  return `this pod serves private documents to strangers (HTTP ${r.status})`;
}
