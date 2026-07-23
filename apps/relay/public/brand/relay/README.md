# Relay brand assets — Orchestration Hub (1D)

Accent: Relay Yellow #F2CD1A · ink #17140a · dark #0d0e10

## Masters (vector, scale to anything)
- relay-icon.svg      app icon: yellow tile + ink mark
- relay-mark.svg      mark only, yellow, transparent
- relay-mark-white.svg / relay-mark-ink.svg  mono variants
- relay-logo.svg      horizontal lockup (mark + "Relay" + CONTROL TOWER), transparent
- relay-logo-dark.svg / relay-logo-light.svg  lockup on a dark / white plate

Wordmark = Space Grotesk 700; kicker = JetBrains Mono 500. Convert text to outlines
if the fonts aren't installed where you open the SVG.

## Favicons / app icons (raster)
- favicon.ico (16/32/48) · favicon-16.png · favicon-32.png · favicon-48.png
- apple-touch-icon.png (180) · icon-192.png · icon-512.png · icon-maskable-512.png

## Wiring
Copy this folder to the app's /public (served at /brand/relay/…), then paste
relay-favicon-head.html into <head>. Adjust the leading path if you place it elsewhere.
