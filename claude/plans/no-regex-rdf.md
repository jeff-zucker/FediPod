# Never parse RDF with a regex

Standing rule, stated 2026-07-31, for every project — not just this one:

> I do not want you EVER to use a regex to parse RDF.

And, when offered a dependency-free alternative (ask for
`application/ld+json` by content negotiation and `JSON.parse` it):

> I would prefer to use rdflib for both reading and writing.

So: **rdflib**, for parsing *and* serialising. Not regexes, not string
concatenation with a hand-rolled literal escaper, not JSON-LD as a way of
dodging the parser.

## Why

Escaping, encoding and shape are exactly what a regex gets wrong quietly — a tab
inside a literal, a `%` or a space in a resource name, a prefixed name where an
absolute IRI was expected, a triple written across lines in a form the pattern
did not anticipate. Nothing throws; you just silently read the wrong thing. And
because a hand-built serialiser writes the documents a hand-built parser reads
back, the two bugs cover for each other until something else reads them.

## Where this project broke it — all five fixed 2026-07-31

| was | now |
|---|---|
| `lib/podrdf.mjs` `readNote()` — Turtle content by regex, with hand-rolled unescaping | rdflib parses; the graph is queried |
| `lib/podrdf.mjs` `listNotes()` — a container listing | `Storage.list()` |
| `lib/store.mjs` `load()` — a container listing | `Storage.list()` |
| `lib/remote.mjs` `listContainer()` — a container listing | rdflib, querying `ldp:contains` |
| `lib/intake.mjs` — the `.well-known/solid` description, to find the WebSocketChannel2023 endpoint | rdflib, asking which subject has that type |

Three of the five were the same job — *give me the children of this container* —
and they collapsed into one implementation, `lib/storage.mjs` (see
`pod-as-relay.md`), where the filesystem case does not produce RDF at all.

The write side went with it: `writeNote`/`writeContacts`/`writeSettings` build a
graph and hand it to `$rdf.serialize`, so the hand-rolled `lit()` escaper — which
handled `\`, `"` and `\n`, stripped `\r`, and passed tabs through raw — is gone.

## Two things the port turned up

**The old listing was reading the wrong thing.** It collected *any*
angle-bracketed URL under the container's own prefix, so a resource merely
mentioned in the document counted as contained in it. The rdflib version asks
for `ldp:contains`, which is what a container actually asserts. Two test
fixtures had to change, because they modelled the sloppiness rather than a real
server — and that is the failure mode exactly: the fixture agreed with the bug.

**rdflib takes a datatype as the SECOND argument.** `$rdf.literal(value,
undefined, XSD('dateTime'))` silently produces an `xsd:string`. Written that
way, every note published from here on would have quietly lost its
`^^xsd:dateTime`. Correct form is `$rdf.literal(value, XSD('dateTime'))`, and
there is now a check that the serialised note still carries the datatype.

## Cost, so it is not a surprise

rdflib 2.4.0 is ~3.6 MB unpacked with ten transitive dependencies — its own n3,
jsonld, xmldom, cross-fetch, @babel/runtime, and two packages named, oddly,
`package.json` and `package-lock.json`. This project has three dependencies and
advertises running under Termux, so that is a real change of character.

Added 2026-07-31 as a direct dependency. `@solid-rest/file` was considered for
the filesystem store and **not** used: the store needs four operations — list,
read, write, remove — and a mini Solid server is a lot of LDP to carry for
something nothing speaks HTTP to. See `pod-as-relay.md`.

## Testing it

The old tests asserted on the serialised *text* — `body.includes('as:attachment
<https://…>')` — which only held because the serialiser was hand-rolled. rdflib
prefixes and abbreviates (`media:p.png`), so those assertions were rewritten as
**round trips**: write a note, read it back, compare the values. That is the
property worth having, and it does not care how the document is spelled. The
fixture content now carries a tab and a quote and a newline on purpose.
