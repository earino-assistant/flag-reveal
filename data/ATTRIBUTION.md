# Data & asset attribution — Flag Reveal

Two distinct sources with two distinct licenses are in play, and they attach to
different artifacts (SPEC-v3.1 §8.3). Both obligations are honored here.

## 1. `data/flags.json` — country names & aliases (ODbL)

`data/flags.json` is a **reduced, modified derivative database** of
[`mledoze/countries`](https://github.com/mledoze/countries). Fields `iso2`
(from `cca2`), `name` (from `name.common`), `aliases` (from `altSpellings`),
and the eligibility filter (`unMember` + UN observer states) are derived from
that dataset. The `tier` (recognizability) values are hand-authored for this
game.

`mledoze/countries` is licensed under the
**Open Database License (ODbL) v1.0**
(https://opendatacommons.org/licenses/odbl/1-0/).

Because `flags.json` is a **derivative database**, ODbL's **attribution** and
**share-alike** obligations apply to the data file independently of whatever
license covers the application code:

- **Attribution:** derived from `mledoze/countries`, © its contributors,
  licensed under ODbL v1.0.
- **Share-alike:** `data/flags.json` (this derivative database) is published
  under **ODbL v1.0**. Any redistribution of a modified `flags.json` must carry
  the same license and attribution.

## 2. `assets/flags/*.svg` — flag images (public-domain flags via flagcdn / MIT via flag-icons)

The vendored SVG flag images are downloaded from
[flagcdn](https://flagcdn.com/) (`https://flagcdn.com/<iso2>.svg`), a set based
on the **public-domain** national flags of the world. Where a flag is not
available from flagcdn, the fallback source is
[`lipis/flag-icons`](https://github.com/lipis/flag-icons), which is licensed
**MIT** — retain the MIT copyright notice for those image assets:

```
The MIT License (MIT)
Copyright (c) 2013 Panayiotis Lipiridis
```

National flags themselves are generally in the public domain; the SVG
renderings carry the license of the set they were drawn from (public-domain /
MIT as above). The images are **vendored** into this repo (not hot-linked) so
the game works offline once served and carries no third-party runtime
dependency (SPEC-v3.1 §8.1–§8.2).

## 3. Application code

The Flag Reveal application code carries its own separate license (see the
repository `LICENSE`), independent of the ODbL data obligation above.
