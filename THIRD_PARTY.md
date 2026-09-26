# Third-party notices

## Body Muscles (anatomical muscle map paths)

The front/back muscle-map figures in `src/template.html` (the `MUSCLES` constant)
use the SVG region paths from **Body Muscles** by Ivan Vulović,
https://github.com/vulovix/body-muscles, licensed under the Apache License,
Version 2.0. Only the path data is used; colouring and grouping are ours.

NOTICE (reproduced as required by the licence):

```
Body Muscles
Copyright 2024 Ivan Vulović

This product includes software developed by Ivan Vulović.
https://github.com/vulovix/body-muscles
```

Licence text: https://www.apache.org/licenses/LICENSE-2.0

## 3D muscle figure (public/muscles.glb)

`public/muscles.glb` is `full-body-male-mobile.glb` from the Fit Mit With anatomy atlas,
https://github.com/slfresh/fitmitwith-anatomy-atlas, licensed CC BY-SA 4.0
(https://creativecommons.org/licenses/by-sa/4.0/). Full credits and the upstream change
log are in `public/muscles-ATTRIBUTION.txt`. Credits requested by the licensors:

- "Z-Anatomy - The libre 3D atlas of anatomy - CC-BY-SA 4.0",
  https://github.com/Z-Anatomy/Models-of-human-anatomy (Kousaku Okubo, Gauthier Kervyn,
  Marcin Zielinski and contributors)
- "BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0
  International", https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html

Changes made at runtime in the page (the file itself is unmodified): muscles are
inflated along their normals, the oblique and transversus aponeuroses in front of the
rectus abdominis are removed, the rectus gets tendinous-intersection grooves, the face
and skull are removed and replaced with a generated head, and every material is recoloured.

## three.js

`public/three/` holds three.js 0.169.0 (`three.module.min.js` and four addons),
https://github.com/mrdoob/three.js, MIT License, Copyright 2010-2024 three.js authors.

## Sora and DM Sans (fonts)

`public/Sora.woff2` (Sora, Jonathan Barnbrook and Julian Moncada) and `public/DMSans.woff2`
(DM Sans, Colophon Foundry) are the Latin variable subsets from Google Fonts, both
SIL Open Font License 1.1. Served as static assets at `/Sora.woff2` and `/DMSans.woff2`.
