// links.mjs — reading RFC 8288 Link headers.
//
// The implementation moved into the pod library (lib/pod/links.mjs), which has
// to carry it: that library runs unmodified in a service worker and may not
// import anything above its own directory. This path stays so the dozen
// importers around the project do not move, and so there is still one obvious
// place to look for "how does this read a Link header".

export { linkTargets, REL } from '../pod/links.mjs';
